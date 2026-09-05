import os
import threading
import time

import requests
from gspread.http_client import HTTPClient

WORKER_BASE = "https://frame-checker-worker.comstralo.workers.dev"
BOT_SECRET = os.getenv("BOT_SECRET")

# Worker(frame-checker-worker)와 이 봇이 같은 Google 서비스 계정을 공유해서
# 쓰기 때문에, Sheets API의 "분당 60회" 할당량도 둘이 함께 나눠 쓴다. Worker는
# 자기 자신의 호출은 이미 인메모리로 세고 있지만 봇의 호출은 전혀 모르므로,
# "Bot·Sheet" 탭의 사용량 모니터링이 실제보다 낮게 보였다 — 이 모듈이 그 빈
# 부분을 채운다.
#
# gspread의 모든 실제 HTTP 요청은 HTTPClient.request() 한 곳을 거치므로,
# 이 메서드를 monkey-patch해서 호출마다 카운트하고 5초에 한 번씩만 Worker에
# 집계치를 전송한다(요청마다 보내면 그 자체가 또 다른 부하가 된다).
_lock = threading.Lock()
_counts = {"read": 0, "write": 0}
_last_sent_at = 0.0
_SEND_INTERVAL_SEC = 5

_original_request = HTTPClient.request


def _patched_request(self, method, endpoint, *args, **kwargs):
    kind = "read" if method.upper() == "GET" else "write"
    with _lock:
        _counts[kind] += 1
    _maybe_flush()
    return _original_request(self, method, endpoint, *args, **kwargs)


def _maybe_flush():
    global _last_sent_at
    now = time.time()
    if now - _last_sent_at < _SEND_INTERVAL_SEC:
        return
    with _lock:
        if _counts["read"] == 0 and _counts["write"] == 0:
            return
        payload = dict(_counts)
        _counts["read"] = 0
        _counts["write"] = 0
        _last_sent_at = now
    _send(payload)


def _send(payload):
    if not BOT_SECRET:
        return
    try:
        requests.post(
            f"{WORKER_BASE}/admin/bot-sheets-usage",
            json=payload,
            headers={"X-Bot-Secret": BOT_SECRET},
            timeout=3,
        )
    except Exception:
        # 사용량 보고 실패는 봇 동작에 영향을 주면 안 된다 — 조용히 무시.
        pass


def install():
    """앱 시작 시 한 번만 호출한다. gspread의 HTTP 요청 경로를 감싸
    실제 Sheets API 호출 수를 Worker에 주기적으로 보고하기 시작한다."""
    HTTPClient.request = _patched_request
