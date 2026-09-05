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


def _start_capture_for_report(ctx, entry):
    nickname = entry.get("nickname")
    reason = entry.get("reason", "")
    reporter_email = entry.get("reporterEmail", "")
    mode = entry.get("mode", "screenshot")
    report_id = entry.get("id")
    if not nickname:
        return

    # thread_id는 모드와 무관하게 닉네임 기준으로 공유한다 — 같은 대상에 대해
    # 스크린샷/영상 제보가 동시에 두 개 진행되지 않도록(set_thread의 중복 방지에 위임).
    thread_id = report_thread_id(nickname)
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
        target_func,
        (nickname, reason, reporter_email, thread_id),
        kwargs={"report_id": report_id},
    )
    if started:
        ctx.logger.info(f"📩 [웹 제보 수신] [{nickname}] {mode} 캡처를 시작합니다. (사유: {reason})")
    else:
        ctx.logger.info(f"📩 [웹 제보 수신] [{nickname}] 이미 캡처가 진행 중이라 건너뜁니다.")


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
            _start_capture_for_report(ctx, entry)
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
