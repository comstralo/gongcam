import os
import threading
import time

import requests

# ✅ [마지막 참여일 이후 집계 차단] 관리자가 "퇴실 처리 (정산)"을 확정하기
# 전까지는 회원 시트가 다른 회원과 똑같이 "살아있는" 상태로 남는다 — 그
# 사이 도움봇이 매 교시 결석 기록("00:00"/ERR)을 계속 남기면 시트 자체의
# 벌금 수식이 새 벌금을 발생시키고, 일요일을 넘기면 앱스크립트 daily_calc()
# 가 새 주간 P 페널티까지 추가할 수 있다(사용자 지적, 2026-09). 이미 마지막
# 참여일이 지난 회원의 exitDate를 Worker에서 주기적으로 가져와 캐시해두면,
# sheets.py의 기록 루프가 그 회원만 건너뛸 수 있다.
WORKER_BASE = "https://frame-checker-worker.comstralo.workers.dev"
BOT_SECRET = os.getenv("BOT_SECRET")
SYNC_INTERVAL_SEC = 60


def _fetch_exit_requests(ctx):
    try:
        res = requests.get(
            f"{WORKER_BASE}/bot/exit-requests",
            headers={"X-Bot-Secret": BOT_SECRET},
            timeout=5,
        )
        res.raise_for_status()
        ctx.exit_requests = res.json().get("exitDates", {}) or {}
    except Exception as e:
        # 조회 실패 시 직전 캐시를 그대로 둔다 — 값을 비워버리면 "이미 퇴실
        # 신청한 회원을 걸러내지 못하는" 안전한 방향의 실패가 아니라, 방금
        # 걸러지고 있던 회원이 갑자기 다시 기록 대상이 되는 예상 밖의 동작이
        # 될 수 있다.
        ctx.logger.warning(f"⚠️ [퇴실 예약 동기화] 조회 실패(직전 값 유지): {e}")


def _sync_loop(ctx):
    ctx.logger.info(f"🚪 [퇴실 예약 동기화] 시작 ({SYNC_INTERVAL_SEC}초 간격)")
    while True:
        _fetch_exit_requests(ctx)
        time.sleep(SYNC_INTERVAL_SEC)


def start_exit_requests_sync(ctx):
    """퇴실 신청 exitDate 캐시(ctx.exit_requests)를 주기적으로 갱신하는
    스레드를 시작한다. BOT_SECRET이 없으면 조용히 건너뛴다(참여자 명단
    동기화와 동일한 폴백 원칙 — 부가 기능이 봇 본연의 동작에 영향을 주지
    않아야 한다). 이 스레드가 아예 안 돌아도 ctx.exit_requests는 빈 dict로
    남아 있어, 기록 루프는 그냥 아무도 스킵하지 않는 기존 동작 그대로다."""
    if not BOT_SECRET:
        ctx.logger.warning("⚠️ [퇴실 예약 동기화] BOT_SECRET이 설정되지 않아 비활성화합니다.")
        return

    threading.Thread(target=_sync_loop, args=(ctx,), daemon=True).start()
