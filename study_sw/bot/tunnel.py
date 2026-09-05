import os
import re
import subprocess
import threading

import requests

# Cloudflare Worker(frame-checker-worker)에 이 봇의 현재 Tunnel URL을 등록해,
# 관리자 웹앱이 상태 조회/재시작 요청을 그 URL로 즉시 프록시할 수 있게 한다.
WORKER_BASE = "https://frame-checker-worker.comstralo.workers.dev"
BOT_SECRET = os.getenv("BOT_SECRET")

TUNNEL_URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def _register_url(ctx, url):
    try:
        res = requests.post(
            f"{WORKER_BASE}/bot/register-url",
            headers={"X-Bot-Secret": BOT_SECRET, "Content-Type": "application/json"},
            json={"url": url},
            timeout=10,
        )
        if res.ok:
            ctx.logger.info(f"🌐 [원격 제어] Tunnel URL을 Worker에 등록했습니다: {url}")
        else:
            ctx.logger.warning(f"⚠️ [원격 제어] Tunnel URL 등록 실패 (status={res.status_code})")
    except Exception as e:
        ctx.logger.warning(f"⚠️ [원격 제어] Tunnel URL 등록 중 오류(무시): {e}")


def _run_tunnel_and_watch(ctx, local_port):
    try:
        process = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{local_port}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError:
        ctx.logger.warning(
            "⚠️ [원격 제어] cloudflared가 설치되어 있지 않아 Tunnel을 시작하지 않습니다. "
            "(brew install cloudflared)"
        )
        return

    url_found = False
    for line in process.stdout:
        if not url_found:
            match = TUNNEL_URL_PATTERN.search(line)
            if match:
                url_found = True
                _register_url(ctx, match.group(0))
    # cloudflared 프로세스가 여기서 끝났다면(정상 종료/크래시) 로그만 남긴다.
    # 봇의 다른 동작은 이 스레드와 무관하게 계속된다.
    ctx.logger.warning("⚠️ [원격 제어] cloudflared 프로세스가 종료되었습니다.")


def start_tunnel_and_register(ctx, local_port=8765):
    """cloudflared Quick Tunnel을 데몬 스레드로 시작하고, 발급된 URL을
    Worker에 등록한다. BOT_SECRET이 없으면 조용히 건너뛴다."""
    if not BOT_SECRET:
        ctx.logger.warning("⚠️ [원격 제어] BOT_SECRET이 설정되지 않아 Tunnel을 시작하지 않습니다.")
        return

    threading.Thread(target=_run_tunnel_and_watch, args=(ctx, local_port), daemon=True).start()
