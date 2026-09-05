import os
import threading
import time

import requests
from selenium.webdriver.common.by import By

# ✅ [참여자 명단 동기화] 현재 구루미 스터디룸에 접속 중인 참여자 닉네임을
# 주기적으로 Cloudflare Worker(Durable Object)에 전송한다. 관리자 웹앱의
# "제보" 페이지가 이 명단을 읽어 대상 참여자 드롭다운을 채운다.
# 실패해도 캠스터디 운영에는 영향이 없도록 예외를 모두 삼킨다.
WORKER_BASE = "https://frame-checker-worker.comstralo.workers.dev"
BOT_SECRET = os.getenv("BOT_SECRET")
SYNC_INTERVAL_SEC = 10


def _get_current_member_list(ctx):
    with ctx.lock_element:
        nickname_elements = ctx.driver.find_elements(
            By.CSS_SELECTOR,
            "div.room-user-list-body span.room-user-nickname",
        )
        # 🔧 .text 대신 textContent 속성을 쓴다. 참여자·채팅 사이드 패널을
        # 닫아둔 상태(enter_studyroom에서 기본으로 닫음)에서는 요소가 DOM에는
        # 있지만 화면에 보이지 않아(visibility) Selenium의 .text가 항상 빈
        # 문자열을 반환한다 — textContent는 가시성과 무관하게 실제 텍스트를 준다.
        raw_texts = [el.get_attribute("textContent") or "" for el in nickname_elements]
        # 빈 문자열(닉네임 텍스트가 아직 렌더링되지 않은 요소 등)은 제외한다.
        # 빈 값이 그대로 프론트엔드 드롭다운의 항목 value로 넘어가면
        # base-ui Select가 해당 항목을 렌더링하지 않는 문제가 있었다.
        return [text for t in raw_texts if (text := t.strip())]


def _push_participants(ctx):
    if ctx.driver is None:
        return
    try:
        members = _get_current_member_list(ctx)
        requests.put(
            f"{WORKER_BASE}/participants",
            json={"members": members},
            headers={"X-Bot-Secret": BOT_SECRET, "Content-Type": "application/json"},
            timeout=5,
        )
    except Exception as e:
        ctx.logger.warning(f"⚠️ [참여자 명단 동기화] 전송 실패(무시): {e}")


def _sync_loop(ctx):
    ctx.logger.info(f"👥 [참여자 명단 동기화] 시작 ({SYNC_INTERVAL_SEC}초 간격)")
    while True:
        _push_participants(ctx)
        time.sleep(SYNC_INTERVAL_SEC)


def start_participants_sync(ctx):
    """참여자 명단 동기화 스레드를 시작한다. BOT_SECRET이 없으면 조용히
    건너뛴다(원격 제어와 동일한 폴백 원칙 — 부가 기능이 봇 본연의 동작에
    영향을 주지 않아야 한다)."""
    if not BOT_SECRET:
        ctx.logger.warning("⚠️ [참여자 명단 동기화] BOT_SECRET이 설정되지 않아 비활성화합니다.")
        return

    threading.Thread(target=_sync_loop, args=(ctx,), daemon=True).start()
