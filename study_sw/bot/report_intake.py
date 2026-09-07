import os
import threading
import time

import requests

from bot.dashboard_server import report_thread_id
from bot.threads import set_thread

# ✅ [웹 제보 수신] 관리자 웹앱의 "제보" 페이지가 POST /report로 접수하면, Worker가
# (frame-checker-worker의 handleReport) 그 즉시 이 봇의 /reports/new로 푸시해서
# 폴링 지연 없이 바로 캡처를 시작한다(dashboard_server.py 참고). 이 파일의 폴링은
# 그 푸시가 실패했을 때(예: 그 순간 Cloudflare Tunnel이 끊겨 있던 경우)만을 위한
# 안전망이라 아주 낮은 빈도로만 돈다.
# /reports는 읽으면 즉시 삭제되는 소비형 큐이므로, 폴링 한 번에 온 항목은
# 이번에만 처리하면 된다.
WORKER_BASE = "https://frame-checker-worker.comstralo.workers.dev"
BOT_SECRET = os.getenv("BOT_SECRET")
# 🔧 [KV list 한도] 이 폴링이 Worker의 handleListReports를 호출할 때마다
# REPORTS_KV.list()가 실행된다. Cloudflare KV 무료 티어는 list 연산이
# 읽기(하루 10만 회)와 별도로 하루 1,000회 한도라서, 예전 10초 간격(하루 8,640회)은
# 이 한도를 8배 넘겨 무료 티어 일일 한도 90%를 소진시켰었다. 이제 이 폴링은
# 안전망 역할만 하므로 10분(하루 144회)이면 충분히 여유 있다.
POLL_INTERVAL_SEC = 600


# 교시 시작 새로고침(period_reload_done, scheduling.py 참고)이 진행 중이면
# 실제 촬영을 시작하지 않고 완료될 때까지 기다린다 — 그러지 않으면 새로고침
# 도중 촬영이 시작되어 화면이 끊긴다(사용자 지시). 대기는 이미 시작된 스레드
# 내부에서만 하고(set_thread 호출 자체는 즉시 반환), 스레드가 ctx.current_threads에
# 먼저 등록되어 있어야 같은 대상에 대한 중복 요청이 그 사이 들어와도
# set_thread의 중복 방지가 정상 동작한다. 타임아웃(60초)은 새로고침이
# 비정상적으로 오래 걸리거나 실패해도 캡처 자체가 영원히 묶이지 않게 하는
# 안전장치 — 실제 새로고침은 보통 수 초~수십 초 내에 끝난다.
RELOAD_WAIT_TIMEOUT_SEC = 60


def _wait_then_capture(
    ctx, target_func, nickname, reason, reporter_email, thread_id, report_id, self_check, reporter_name
):
    if not ctx.period_reload_done.wait(timeout=RELOAD_WAIT_TIMEOUT_SEC):
        ctx.logger.warning(
            f"⚠️ [웹 제보 수신] [{nickname}] 교시 시작 새로고침 대기 시간 초과 — 그대로 촬영을 시작합니다."
        )
    target_func(
        ctx,
        nickname,
        reason,
        reporter_email,
        thread_id,
        report_id=report_id,
        self_check=self_check,
        reporter_name=reporter_name,
    )


# 🔧 [버그 수정] 원래는 반환값이 없었다 — 호출자인 /reports/new 핸들러가
# 이 함수의 성공/실패와 무관하게 항상 202를 응답해, Worker(handleReport)가
# "HTTP 푸시 성공 = 캡처가 실제로 시작됨"으로 오해해 report:{id} KV를 그
# 자리에서 지워버렸다(6차 라운드 수정). 그런데 실제로는 set_thread가 같은
# thread_id(닉네임 기준 공유)로 이미 진행 중인 캡처가 있으면 새로 시작하지
# 않고 조용히 건너뛰기만 한다 — 예를 들어 어떤 사람의 "내 화각 점검"(self
# -check, 별도 쿨다운 키를 씀)이 진행 중인 동안 다른 사람이 같은 대상을
# 진짜로 신고하면(일반 제보는 다른 쿨다운 키라 막히지 않음), 봇 쪽에서는
# 같은 닉네임이라 thread_id가 겹쳐 두 번째 제보가 조용히 스킵됐다. 이때도
# HTTP는 200을 반환해 Worker가 KV를 지워버려서, 진짜 위반 제보가 캡처도
# 텔레그램 알림도 manifest 기록도 없이 조용히 영구 소실되고 제보자에게는
# "제보가 접수되었습니다"라는 성공 메시지만 보였다. 이제 실제로 캡처가
# 시작됐는지(started)를 그대로 반환해, 호출자가 이 값을 Worker에 전달할 수
# 있게 한다 — Worker는 started가 true일 때만 KV를 지우고, false면 안전망
# 폴링이 나중에 다시 시도하도록 KV를 그대로 남겨둔다.
def _start_capture_for_report(ctx, entry):
    nickname = entry.get("nickname")
    reason = entry.get("reason", "")
    reporter_email = entry.get("reporterEmail", "")
    # 텔레그램 캡션에 "제보자: <이름>"으로 보여주기 위함 — manifest에 저장되는
    # reporterEmail(제보상점 지급 시 회원 매칭용)과는 별개로, 표시 전용이다.
    reporter_name = entry.get("reporterName", "")
    mode = entry.get("mode", "screenshot")
    report_id = entry.get("id")
    self_check = bool(entry.get("selfCheck"))
    is_admin = bool(entry.get("isAdmin"))
    if not nickname:
        return False

    # thread_id는 모드와 무관하게 닉네임 기준으로 공유한다 — 같은 대상에 대해
    # 스크린샷/영상 제보가 동시에 두 개 진행되지 않도록(set_thread의 중복 방지에 위임).
    # 🔧 [관리자 중복 제보 허용] 관리자가 같은 대상을 짧은 간격으로 연달아
    # 제보하면(예: 첫 캡처가 아직 진행 중인 150초 안에 두 번째 제보), 이
    # 공유 thread_id 때문에 두 번째 요청이 조용히 무시돼 실제로 접수된
    # 제보 하나가 통째로 사라졌다(사용자 보고). 관리자 제보는 report_id를
    # 섞어 매번 다른 thread_id를 만들어, 같은 대상이라도 동시에 여러 건이
    # 병행 진행될 수 있게 한다 — 일반 제보(20분 쿨다운으로 이미 중복이
    # 걸러짐)는 기존처럼 닉네임 공유 thread_id를 그대로 쓴다.
    thread_id = f"{report_thread_id(nickname)} / [{report_id}]" if is_admin and report_id else report_thread_id(nickname)
    # 🔧 순환 임포트 방지: bot.tracking은 이 모듈과 직접 순환하지 않지만,
    # bot.report_intake -> bot.dashboard_server -> bot.gooroomee_room으로
    # 이어지는 임포트 순서를 다른 지역 임포트들과 일관되게 유지하기 위해 지역 임포트한다.
    if mode == "video":
        from bot.tracking import tracking_capture_video

        target_func = tracking_capture_video
    else:
        from bot.tracking import tracking_capture

        target_func = tracking_capture

    started = set_thread(
        ctx,
        thread_id,
        _wait_then_capture,
        (target_func, nickname, reason, reporter_email, thread_id, report_id, self_check, reporter_name),
    )
    if started:
        ctx.logger.info(f"📩 [웹 제보 수신] [{nickname}] {mode} 캡처를 시작합니다. (사유: {reason})")
    else:
        ctx.logger.info(f"📩 [웹 제보 수신] [{nickname}] 이미 캡처가 진행 중이라 건너뜁니다.")
    return started


def _poll_and_start_captures(ctx):
    if ctx.driver is None:
        return
    try:
        res = requests.get(
            f"{WORKER_BASE}/reports",
            headers={"X-Bot-Secret": BOT_SECRET},
            timeout=10,
        )
        if not res.ok:
            return
        entries = res.json()
        for entry in entries:
            # 🔧 [버그 수정] 원래는 이 반환값을 그냥 버렸다 — GET /reports는
            # Worker(handleListReports)가 읽는 즉시 report:{id} KV를 무조건
            # 지우고 넘겨주는 소비형 큐라서, 여기서 set_thread가 조용히
            # 건너뛰면(같은 대상에 대한 다른 캡처가 여전히 진행 중인 경우)
            # 그 시점부터는 Worker KV에도 없고 봇도 처리하지 않은 채로 이
            # 제보가 완전히 영구 소실됐다(즉시 푸시 경로의 "started 확인
            # 후에만 KV 삭제" 안전장치는 이미 지워진 뒤 넘어오는 이 안전망
            # 경로 자체에는 적용되지 않는 구조적 한계였다). 건너뛴 경우
            # /reports/requeue로 그 entry를 Worker에 되돌려 보내, 다음
            # 안전망 주기(10분 뒤, 그때는 먼저 진행 중이던 캡처가 끝나
            # thread_id가 비어 있을 가능성이 높음)에 다시 시도할 수 있게
            # 한다. 원래 접수 시각(entry["ts"]) 기준 TTL이 이미 다 됐으면
            # Worker가 재등록을 건너뛰므로 무한정 되살아나지는 않는다.
            started = _start_capture_for_report(ctx, entry)
            if not started:
                try:
                    requests.post(
                        f"{WORKER_BASE}/reports/requeue",
                        json=entry,
                        headers={"X-Bot-Secret": BOT_SECRET},
                        timeout=10,
                    )
                except Exception as e:
                    ctx.logger.warning(f"⚠️ [웹 제보 수신] 재등록 실패(무시): {e}")
    except Exception as e:
        ctx.logger.warning(f"⚠️ [웹 제보 수신] 폴링 실패(무시): {e}")


def _poll_loop(ctx):
    ctx.logger.info(f"📩 [웹 제보 수신] 폴링 시작 ({POLL_INTERVAL_SEC}초 간격)")
    while True:
        _poll_and_start_captures(ctx)
        time.sleep(POLL_INTERVAL_SEC)


def start_report_intake(ctx):
    """웹 제보 폴링 스레드를 시작한다. BOT_SECRET이 없으면 조용히 건너뛴다
    (원격 제어·명단 동기화와 동일한 폴백 원칙)."""
    if not BOT_SECRET:
        ctx.logger.warning("⚠️ [웹 제보 수신] BOT_SECRET이 설정되지 않아 비활성화합니다.")
        return

    threading.Thread(target=_poll_loop, args=(ctx,), daemon=True).start()
