import base64
import json
import os
import threading
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from selenium.webdriver.common.by import By

from bot import capture_manifest, leave_proof_manifest

CAPTURES_DIR = "runtime/captures/report"
LEAVE_PROOF_DIR = "runtime/leave_proof/files"
LEAVE_PROOF_MAX_BYTES = 5 * 1024 * 1024  # 5MB, 프론트에서 이미 검증하지만 서버도 방어

# ✅ [원격 제어] Cloudflare Tunnel로 노출되는 봇의 로컬 상태 서버.
# Worker는 관리자가 상태를 조회하거나 재시작을 누를 때만 이 서버에
# 즉시 요청을 프록시한다(하트비트 폴링 없음). X-Dashboard-Secret 헤더로
# 요청을 검증해, Tunnel URL을 아는 누구나가 아니라 Worker(BOT_SECRET 소지자)만
# 호출할 수 있게 한다.
DASHBOARD_SECRET = os.getenv("BOT_SECRET")
LOG_TAIL_LINES = 20


def _room_state_unlocked(ctx):
    """bot/gooroomee_room.py의 enter_studyroom()과 동일한 판정 기준을 쓴다:
    URL에 '#coordi;'(입장 전 설정 화면)가 없고, 참여자 수 UI(room-join-count)가
    실제로 화면에 표시되고 있으면 방 내부로 간주한다. 호출부에서 ctx.lock_element로
    감싸야 한다(driver 접근이라 다른 스레드와 경합할 수 있음)."""
    if ctx.driver is None:
        return "outside"
    try:
        current_url = ctx.driver.current_url
        join_count_elements = ctx.driver.find_elements(By.CSS_SELECTOR, "div.room-join-count")
        if (
            "#coordi;" not in current_url
            and len(join_count_elements) > 0
            and join_count_elements[0].is_displayed()
        ):
            return "in_room"
        return "outside"
    except Exception:
        # 드라이버가 죽어있거나(탭 크래시 등) 조회 타이밍에 예외가 나면 외부로 간주.
        return "outside"


def _screenshot_unlocked(ctx):
    """현재 크롬 창 전체를 base64 PNG로 캡처한다. 실패하면 None(프론트에서
    이미지 영역을 그냥 숨긴다). 호출부에서 ctx.lock_element로 감싸야 한다."""
    if ctx.driver is None:
        return None
    try:
        return ctx.driver.get_screenshot_as_base64()
    except Exception:
        return None


def _status_snapshot(ctx):
    """방 상태와 스크린샷을 한 번의 lock_element 구간 안에서 함께 얻는다 —
    두 번 나눠 잠그면 그 사이 화면이 바뀌어 상태와 스크린샷이 어긋날 수 있다."""
    with ctx.lock_element:
        return _room_state_unlocked(ctx), _screenshot_unlocked(ctx)


def report_thread_id(nickname):
    """제보 캡처 스레드의 thread_id 포맷. bot/report_intake.py와 동일한
    포맷을 써야 ctx.current_threads 조회로 진행 여부를 정확히 판별할 수 있다."""
    return f"[송출 페널티 위반 감독] / [대상자 : {nickname}]"


def _read_recent_logs():
    log_path = os.path.join("runtime", "logs", datetime.now().strftime("%Y-%m-%d.log"))
    try:
        with open(log_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
        return [line.rstrip("\n") for line in lines[-LOG_TAIL_LINES:]]
    except Exception:
        return []


def make_dashboard_handler(ctx):
    # 🔧 [순환 임포트 방지] daily_browser_reset은 bot.gooroomee_room에 있고,
    # bot.gooroomee_room은 이 모듈을 임포트하지 않으므로 top-level 임포트가
    # 안전하지만, 이 서버 자체가 여러 봇 모듈이 완성된 뒤(엔트리포인트)에만
    # 기동되는 편이 자연스러워 지역 임포트로 지연시킨다.
    from bot.gooroomee_room import daily_browser_reset

    class DashboardHandler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # 표준 접근 로그를 콘솔에 남기지 않는다 — ctx.logger가 이미
            # 봇의 다른 활동을 자세히 기록하므로 여기까지 겹치면 소음이 된다.
            pass

        def _unauthorized(self):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "unauthorized"}).encode("utf-8"))

        def _check_secret(self):
            if not DASHBOARD_SECRET:
                return False
            return self.headers.get("X-Dashboard-Secret") == DASHBOARD_SECRET

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_file(self, path, content_type):
            if not os.path.exists(path):
                self._send_json(404, {"error": "not found"})
                return
            with open(path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urlparse(self.path)

            if parsed.path == "/status":
                if not self._check_secret():
                    self._unauthorized()
                    return
                room_state, screenshot_base64 = _status_snapshot(ctx)
                self._send_json(
                    200,
                    {
                        "online": True,
                        "roomState": room_state,
                        "screenshot": screenshot_base64,
                        "recentLogs": _read_recent_logs(),
                    },
                )
                return

            if parsed.path == "/report-status":
                if not self._check_secret():
                    self._unauthorized()
                    return
                nickname = parse_qs(parsed.query).get("nickname", [""])[0]
                in_progress = report_thread_id(nickname) in ctx.current_threads
                self._send_json(
                    200,
                    {
                        "inProgress": in_progress,
                        "recentLogs": _read_recent_logs(),
                    },
                )
                return

            if parsed.path == "/captures":
                if not self._check_secret():
                    self._unauthorized()
                    return
                status = parse_qs(parsed.query).get("status", [None])[0]
                self._send_json(200, {"items": capture_manifest.list_captures(status)})
                return

            if parsed.path == "/captures/file":
                if not self._check_secret():
                    self._unauthorized()
                    return
                capture_id = parse_qs(parsed.query).get("id", [""])[0]
                item = capture_manifest.get_capture(capture_id)
                if not item:
                    self._send_json(404, {"error": "not found"})
                    return
                filename = item["filename"]
                content_type = "video/mp4" if filename.endswith(".mp4") else "image/png"
                self._send_file(os.path.join(CAPTURES_DIR, filename), content_type)
                return

            if parsed.path == "/leave-proof":
                if not self._check_secret():
                    self._unauthorized()
                    return
                q = parse_qs(parsed.query)
                status = q.get("status", [None])[0]
                member_number = q.get("number", [None])[0]
                self._send_json(
                    200, {"items": leave_proof_manifest.list_requests(status, member_number)}
                )
                return

            if parsed.path == "/leave-proof/file":
                if not self._check_secret():
                    self._unauthorized()
                    return
                request_id = parse_qs(parsed.query).get("id", [""])[0]
                item = leave_proof_manifest.get_request(request_id)
                if not item:
                    self._send_json(404, {"error": "not found"})
                    return
                filename = item["filename"]
                content_type = "image/png" if filename.lower().endswith(".png") else "image/jpeg"
                self._send_file(os.path.join(LEAVE_PROOF_DIR, filename), content_type)
                return

            if parsed.path == "/debug-roster":
                if not self._check_secret():
                    self._unauthorized()
                    return
                if ctx.driver is None:
                    self._send_json(200, {"error": "no driver"})
                    return
                with ctx.lock_element:
                    try:
                        panel_present = len(ctx.driver.find_elements(By.CSS_SELECTOR, "div.room-user-list-body"))
                        nick_els = ctx.driver.find_elements(
                            By.CSS_SELECTOR, "div.room-user-list-body span.room-user-nickname"
                        )
                        nick_texts = [el.get_attribute("textContent") for el in nick_els]
                        toggle_btns = ctx.driver.find_elements(
                            By.CSS_SELECTOR, "[data-type='close'].btn-right-side-toggle"
                        )
                        any_nickname_anywhere = ctx.driver.find_elements(By.CSS_SELECTOR, "span.room-user-nickname")
                        any_nickname_texts = [el.get_attribute("textContent") for el in any_nickname_anywhere]
                    except Exception as e:
                        self._send_json(200, {"error": str(e)})
                        return
                self._send_json(
                    200,
                    {
                        "panel_present": panel_present,
                        "nick_count_in_panel": len(nick_els),
                        "nick_texts_in_panel": nick_texts,
                        "close_toggle_btn_count": len(toggle_btns),
                        "any_nickname_anywhere_count": len(any_nickname_anywhere),
                        "any_nickname_anywhere_texts": any_nickname_texts,
                    },
                )
                return

            self._send_json(404, {"error": "not found"})

        def do_POST(self):
            parsed = urlparse(self.path)

            if parsed.path == "/restart":
                if not self._check_secret():
                    self._unauthorized()
                    return

                ctx.logger.info("🔁 [원격 제어] 관리자 명령으로 브라우저를 재시작합니다.")
                threading.Thread(
                    target=daily_browser_reset,
                    args=(ctx,),
                    kwargs={"is_emergency": False},
                    daemon=True,
                ).start()
                self._send_json(202, {"ok": True, "command": "restart"})
                return

            if parsed.path == "/captures/decide":
                if not self._check_secret():
                    self._unauthorized()
                    return
                length = int(self.headers.get("Content-Length", 0))
                try:
                    body = json.loads(self.rfile.read(length)) if length else {}
                except Exception:
                    body = {}
                capture_id = body.get("id")
                decision = body.get("decision")
                if not capture_id or decision not in ("approved", "rejected"):
                    self._send_json(400, {"error": "invalid request"})
                    return
                ok = capture_manifest.set_decision(capture_id, decision)
                self._send_json(200 if ok else 404, {"ok": ok})
                return

            if parsed.path == "/captures/delete":
                if not self._check_secret():
                    self._unauthorized()
                    return
                length = int(self.headers.get("Content-Length", 0))
                try:
                    body = json.loads(self.rfile.read(length)) if length else {}
                except Exception:
                    body = {}
                capture_id = body.get("id")
                if not capture_id:
                    self._send_json(400, {"error": "invalid request"})
                    return
                ok = capture_manifest.delete_capture(capture_id)
                self._send_json(200 if ok else 404, {"ok": ok})
                return

            if parsed.path == "/leave-proof/new":
                if not self._check_secret():
                    self._unauthorized()
                    return
                length = int(self.headers.get("Content-Length", 0))
                try:
                    body = json.loads(self.rfile.read(length)) if length else {}
                except Exception:
                    body = {}

                member_number = body.get("memberNumber")
                member_name = body.get("memberName", "")
                day = body.get("day")
                reason = (body.get("reason") or "").strip()
                requester_email = body.get("requesterEmail", "")
                image_b64 = body.get("imageBase64")
                image_ext = body.get("imageExt")
                count = body.get("count", 1)
                # Worker의 KV 오프라인 대기열(leaveq:*)이 flush될 때 큐 항목의
                # 원래 id를 그대로 넘긴다 — 지정되지 않으면(정상 실시간 경로)
                # 새로 발급한다.
                entry_id = body.get("id")

                if (
                    not member_number
                    or not day
                    or not reason
                    or not image_b64
                    or image_ext not in ("jpg", "png")
                    or count not in (1, 2)
                ):
                    self._send_json(400, {"error": "invalid request"})
                    return

                try:
                    raw = base64.b64decode(image_b64, validate=True)
                except Exception:
                    self._send_json(400, {"error": "invalid image data"})
                    return

                if len(raw) > LEAVE_PROOF_MAX_BYTES:
                    self._send_json(400, {"error": "image too large"})
                    return

                os.makedirs(LEAVE_PROOF_DIR, exist_ok=True)
                filename = f"{uuid.uuid4()}.{image_ext}"
                with open(os.path.join(LEAVE_PROOF_DIR, filename), "wb") as f:
                    f.write(raw)

                entry_id = leave_proof_manifest.record_request(
                    member_number, member_name, day, reason, filename, requester_email, count, entry_id
                )
                self._send_json(202, {"ok": True, "id": entry_id})
                return

            if parsed.path == "/leave-proof/decide":
                if not self._check_secret():
                    self._unauthorized()
                    return
                length = int(self.headers.get("Content-Length", 0))
                try:
                    body = json.loads(self.rfile.read(length)) if length else {}
                except Exception:
                    body = {}
                request_id = body.get("id")
                decision = body.get("decision")
                reject_reason = body.get("rejectReason")
                if not request_id or decision not in ("approved", "rejected"):
                    self._send_json(400, {"error": "invalid request"})
                    return
                ok = leave_proof_manifest.set_decision(request_id, decision, reject_reason)
                self._send_json(200 if ok else 404, {"ok": ok})
                return

            if parsed.path == "/reports/new":
                if not self._check_secret():
                    self._unauthorized()
                    return
                length = int(self.headers.get("Content-Length", 0))
                try:
                    entry = json.loads(self.rfile.read(length)) if length else {}
                except Exception:
                    entry = {}
                # 🔧 [순환 임포트 방지] report_intake.py가 이 모듈의 report_thread_id를
                # 이미 임포트하고 있어서, 여기서 최상단에 report_intake를 다시
                # 임포트하면 순환이 생긴다. daily_browser_reset과 동일하게
                # 실제로 쓰는 시점(요청이 들어왔을 때)에만 지역 임포트한다.
                from bot.report_intake import _start_capture_for_report

                _start_capture_for_report(ctx, entry)
                self._send_json(202, {"ok": True})
                return

            self._send_json(404, {"error": "not found"})

    return DashboardHandler


def start_dashboard_server(ctx, port=8765):
    """로컬 상태 서버를 데몬 스레드로 시작하고, 실제 바인딩된 포트를 반환한다.
    BOT_SECRET이 없으면(.env 미설정) 조용히 건너뛴다 — 원격 제어는 봇의
    다른 동작과 무관한 부가 기능이므로 여기서 실패해도 봇은 계속 동작해야 한다."""
    if not DASHBOARD_SECRET:
        ctx.logger.warning("⚠️ [원격 제어] BOT_SECRET이 설정되지 않아 상태 서버를 비활성화합니다.")
        return None

    handler_cls = make_dashboard_handler(ctx)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler_cls)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ctx.logger.info(f"🖥️ [원격 제어] 로컬 상태 서버 시작 (127.0.0.1:{port})")
    return server
