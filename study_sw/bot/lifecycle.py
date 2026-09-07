import logging
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta

import psutil
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait

from bot.telegram import send_chat_telegram
from bot.threads import stop_all_thread

try:
    import win32con

    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False

# 현재 Python 실행 경로 가져오기
python_executable = sys.executable

# 브라우저 데이터 저장 경로 설정
# 🔧 [모듈 분리] 원래 이 코드는 프로젝트 루트의 study_manager_260418.py에 있어
# __file__이 곧 프로젝트 루트를 가리켰다. bot/lifecycle.py로 옮기면서 __file__이
# bot/ 하위를 가리키게 되므로, 상위 디렉토리(프로젝트 루트)로 한 단계 보정한다.
current_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 프로젝트 루트 경로
user_data_dir = os.path.join(current_dir, "chrome_profile")  # 폴더 경로 생성
# user_data_dir = r"C:\Users\oheeryeo\AppData\Local\Google\Chrome\User Data"


# 🔧 [로그 강화] 원래는 날짜별 로그 파일이 무기한 쌓이기만 했다 —
# 급한 문제는 아니지만(텍스트 로그라 용량 자체는 작음) 관리되지 않는
# 상태였다. 롤오버(자정이 지나 새 파일을 여는 시점)마다 이보다 오래된
# 파일을 정리한다 — 동시성 버그를 사후 진단할 때 몇 주 전 로그까지
# 필요한 경우는 드물다고 보고 여유 있게 잡는다.
LOG_RETENTION_DAYS = 60


# --- ❗ 1. 커스텀 로그 핸들러 클래스 정의 (수정됨) ❗ ---
class DailyLogHandler(logging.FileHandler):
    """
    자정이 되면 파일명이 날짜에 따라 자동으로 변경되는 커스텀 로그 핸들러.
    """

    def __init__(self, filename_pattern, encoding=None, delay=False):
        self.filename_pattern = filename_pattern
        # super().__init__ 호출 시, 인자를 이름으로 명확하게 전달합니다.
        super().__init__(
            filename=datetime.now().strftime(self.filename_pattern),
            encoding=encoding,
            delay=delay,
        )
        self.current_date = datetime.now().date()

    def _cleanup_old_logs(self):
        log_dir = os.path.dirname(self.baseFilename) or "."
        cutoff = datetime.now().date() - timedelta(days=LOG_RETENTION_DAYS)
        try:
            for name in os.listdir(log_dir):
                if not (name.endswith(".log") and len(name) == len("YYYY-MM-DD.log")):
                    continue
                try:
                    file_date = datetime.strptime(name[:-4], "%Y-%m-%d").date()
                except ValueError:
                    continue
                if file_date < cutoff:
                    try:
                        os.remove(os.path.join(log_dir, name))
                    except OSError:
                        pass
        except OSError:
            pass

    def emit(self, record):
        today = datetime.now().date()
        if today != self.current_date:
            self.stream.close()
            self.baseFilename = datetime.now().strftime(self.filename_pattern)
            self.stream = self._open()
            self.current_date = today
            self._cleanup_old_logs()
        super().emit(record)


def build_chrome_options():
    """Chrome 실행 옵션을 구성. 최초 기동 시와 daily_browser_reset()의
    재기동 시 모두 동일한 옵션이 필요하므로 별도 함수로 분리한다."""
    options = Options()

    # --- [기본 유지 옵션] ---
    options.add_argument(f"user-data-dir={user_data_dir}")
    options.add_argument(r"profile-directory=Default")
    options.add_argument("--use-fake-ui-for-media-stream")
    options.add_argument("--log-level=3")

    # --- [헤드리스 전환] ---
    # 캡처(get_screenshot_as_png)가 실행될 때 macOS가 가려진/백그라운드 창을
    # 화면 최전면으로 끌어올리는 문제(사용자 보고로 확인)가 있어, 아예 화면에
    # 창을 띄우지 않는 headless 모드로 전환한다. headless여도 카메라/마이크
    # 미디어 스트림 캡처(WebRTC)와 화면 캡처(CDP Page.captureScreenshot)는
    # 정상 동작한다 — 둘 다 실제 창의 화면 표시 여부와 무관하게 내부 렌더링
    # 버퍼를 기준으로 동작하기 때문이다. maximize_window()는 headless에서
    # 의미가 없어 --window-size로 대체한다.
    options.add_argument("--headless=new")
    options.add_argument("--window-size=1920,1080")
    # options.add_extension(r"resource\coldturkey.crx")

    # --- [1. N5105 CPU 과부하 방지 (매우 중요)] ---
    # 🚨 주의: 이전의 --disable-gpu 관련 옵션은 절대 넣지 마세요!
    # N5105는 내장 그래픽(UHD Graphics)의 하드웨어 가속을 무조건 받아야 CPU가 뻗지 않습니다.
    options.add_argument(
        "--ignore-gpu-blocklist"
    )  # 구형 내장 그래픽이라도 강제로 GPU 가속 사용
    options.add_argument(
        "--mute-audio"
    )  # 16명의 오디오 디코딩을 차단하여 CPU 연산 대폭 절약

    # --- [2. 8GB RAM 맞춤 메모리 최적화] ---
    # 공유 메모리 초과로 인한 크래시 방지 (디스크를 임시로 사용)
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--no-sandbox")

    # 16인 레이아웃을 띄우려면 2GB 제한은 너무 빡빡해서 역효과가 날 수 있습니다.
    # 여유 램을 고려해 V8 자바스크립트 엔진 한도를 3GB(3072MB)로 타협합니다.
    options.add_argument("--js-flags=--max-old-space-size=3072")

    # 각 캠 화면을 독립된 프로세스로 쪼개는 것을 막아 메모리 낭비 차단
    options.add_argument("--disable-site-isolation-trials")

    # --- [3. 불필요한 크롬 백그라운드 기능 차단 (Debloat)] ---
    # options.add_argument("--disable-extensions")
    options.add_argument("--disable-sync")
    options.add_argument("--disable-default-apps")
    options.add_argument("--disable-background-networking")
    options.add_argument("--disable-features=Translate,OptimizationHints")

    # --- [기존 prefs 설정 유지] ---
    prefs = {
        "profile.default_content_setting_values.media_stream_mic": 1,
        "profile.default_content_setting_values.media_stream_camera": 1,
        "profile.default_content_setting_values.geolocation": 1,
        "profile.default_content_setting_values.notifications": 1,
    }
    options.add_experimental_option("prefs", prefs)
    options.add_experimental_option("excludeSwitches", ["enable-logging"])

    return options


def build_context_and_driver():
    """BotContext를 생성하고, 로거/캠 서브프로세스/Chrome 드라이버/감시자 스레드를
    모두 셋업한 뒤 완성된 ctx를 반환한다. 모듈을 import하는 것만으로는 아무런
    부작용(실제 Chrome 실행 등)이 발생하지 않도록, 이 함수는 반드시 명시적으로
    호출되어야 한다 (entrypoint에서 호출)."""
    from bot.context import BotContext

    ctx = BotContext()

    # --- ❗ 1. 로그 설정 ❗ ---
    log_dir = "runtime/logs"
    logger = logging.getLogger("my_daily_logger")
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")

    # 콘솔 핸들러
    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)

    # 커스텀 파일 핸들러
    file_handler = DailyLogHandler(
        filename_pattern=os.path.join(log_dir, "%Y-%m-%d.log"),
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    ctx.logger = logger

    # pycam.py를 해당 환경에서 실행
    ctx.cam_process = subprocess.Popen(
        [python_executable, "study_manager_cam_260418.py"]
    )

    options = build_chrome_options()

    ctx.driver = webdriver.Chrome(options=options)
    # headless 모드에서 maximize_window()는 창이 실존하지 않아 의미가 없으므로
    # build_chrome_options()의 --window-size=1920,1080과 짝을 맞춰 명시적으로 설정한다.
    ctx.driver.set_window_size(1920, 1080)
    ctx.driver.set_page_load_timeout(30)

    # ▼ 브라우저가 켜지자마자 감시자(CCTV) 실행 ----------------
    threading.Thread(target=browser_watchdog, args=(ctx,), daemon=True).start()
    print("✅ [시스템] 브라우저 감시자(Watchdog)가 실행되었습니다.")

    ctx.wait = WebDriverWait(ctx.driver, 10)

    return ctx


# 🔧 [버그 수정] cleanup_and_exit가 stop_all_thread(아래)를 거치게 되면서
# 진행 중인 캡처 스레드 수만큼(스레드당 최대 11초) 오래 걸리는 함수가
# 됐다. SIGTERM/SIGINT/SIGHUP은 모두 이 함수에 연결되는데, CPython의
# signal 핸들러는 재진입 가능해 — 첫 신호로 이 함수가 느린 정리 작업
# 도중일 때 관리자가 응답이 없다고 느껴 신호를 한 번 더 보내면(이번
# 세션에서 실제로 kill -TERM 후 응답 확인 없이 재기동하는 패턴을 써왔다),
# 인터프리터가 핸들러를 처음부터 다시 실행한다. 두 실행 흐름이 겹치면
# ctx.driver.quit()이 동시에 두 번 호출되는 등 경쟁이 생기고, 어느 쪽이
# 먼저 os._exit(0)에 도달하느냐에 따라 다른 쪽의 정리 작업(재개 정보
# 저장 포함)이 도중에 끊긴 채 죽을 수 있다 — 이 함수를 느리게 만든
# 목적(안전한 재개 정보 저장) 자체가 무력화되는 역설이 생긴다. 모듈
# 전역 플래그로 재진입을 막는다 — 리스트/딕셔너리 조작처럼 GIL 아래
# 원자적인 단순 대입이라 별도 락 없이도 안전하다(이 함수 자체가 락을
# 요구하는 구간에 들어가기 전에 체크·설정을 끝낸다).
_cleanup_in_progress = False


# 💡 인자(signum, frame)를 선택적으로 받도록 수정 (atexit 등에서 호출할 때 에러 방지)
def cleanup_and_exit(ctx, signum=None, frame=None):
    global _cleanup_in_progress
    if _cleanup_in_progress:
        # 이미 정리 작업이 진행 중인데 신호가 또 왔다는 것은 관리자가
        # "더 기다리지 않고 즉시 종료해달라"는 의사로 해석해, 겹쳐서
        # 정리를 재시도하는 대신 그 자리에서 바로 강제 종료한다 — 어중간한
        # 상태로 두 실행 흐름이 서로 경쟁하는 것보다, 이미 첫 실행이 어디까지
        # 정리했든 그 상태 그대로 즉시 끝내는 편이 안전하다.
        print("\n🚨 [시스템] 종료 신호가 다시 감지되어 즉시 강제 종료합니다.")
        os._exit(1)
    _cleanup_in_progress = True

    print("\n🚨 [시스템] 프로그램 종료 신호 감지! 브라우저를 안전하게 닫습니다.")

    # 🔧 [버그 수정] 재진입 가드(_cleanup_in_progress)는 이 함수가 os._exit로
    # 끝나는 것을 전제로 "두 번째 호출은 항상 재진입"이라고 판단한다 —
    # 그런데 원래는 kill_selenium_processes() 호출(맨 아래)에 예외 처리가
    # 없었다. 만약 이 호출이나 그 내부 루프가 예상 못 한 예외를 던지면
    # cleanup_and_exit가 os._exit에 끝내 도달하지 못한 채 예외로 중간
    # 이탈했다 — 그러면 _cleanup_in_progress는 True로 영구 고정된 채
    # 프로세스는 계속 살아있을 수 있고(시그널 핸들러 밖으로 예외가 새면
    # 인터프리터가 죽지 않는다), 그 이후 관리자가 보내는 모든 정상적인
    # 재종료 신호가 stop_all_thread의 정리 작업 없이 곧장 os._exit(1)
    # 강제종료로 처리됐다 — 이 가드가 막으려던 "정리 도중 끊김"을 가드
    # 자신이 만들어내는 자기모순이었다. try/finally로 함수 본문 전체를
    # 감싸, 어떤 단계에서 무슨 예외가 나든 finally에서 반드시 os._exit이
    # 실행되게 한다(각 정리 단계의 개별 try/except는 "그 단계가 실패해도
    # 다음 단계는 계속 시도한다"는 의미로 그대로 유지 — 이 finally는
    # "혹시 그 방어망까지 뚫는 완전히 예상 못 한 예외"에 대한 마지막
    # 안전망이다).
    try:
        # 🔧 [버그 수정] 원래는 이 함수가 stop_event/stop_all_thread를 전혀
        # 거치지 않고 곧장 os._exit(0)으로 직행했다 — SIGTERM/SIGINT/SIGHUP은
        # 모두 이 함수로 연결되므로(study_manager_260418.py), 관리자가 봇을
        # "정상적으로" 재시작할 때마다(터미널 Ctrl+C, 배포 스크립트의 SIGTERM
        # 등) 진행 중이던 모든 캡처 스레드가 tracking_capture의 정상 중단
        # 처리(완전한 재개 정보를 남기는 경로, stop_event.is_set() 분기)를
        # 타지 못한 채 즉시 죽었다. 즉사 방어(threads.py의 inflight snapshot)가
        # 원래 대비하려던 건 "atexit/signal 핸들러조차 못 타는" OOM/kill -9/
        # 정전 같은 진짜 예외 상황인데, 실제로는 정상 종료 신호를 받을 때마다
        # 매번 그 예외 상황과 동일하게 취급됐다. stop_all_thread()를 먼저
        # 호출해 각 스레드가 정상 중단 처리(재개 정보 저장, 시트 기록 완료
        # 대기 등)를 마칠 시간을 준 뒤에 종료한다.
        try:
            stop_all_thread(ctx)
        except Exception:
            pass

        # 추가: 서브프로세스 종료
        try:
            if ctx.cam_process is not None:
                ctx.cam_process.terminate()
                print("✅ [시스템] 캠 매니저 서브프로세스 종료 완료.")
        except Exception:
            pass

        try:
            if ctx.driver is not None:
                ctx.driver.quit()  # 크롬 브라우저 정상 종료
                print("✅ [시스템] 크롬 브라우저 종료 완료.")
        except Exception:
            pass

        # 프로세스 잔해 완전 박살 (Windows 기준)
        # 주의: 이 명령어는 사용자가 개인적으로 띄워둔 다른 모든 크롬창도 닫아버릴 수 있습니다.
        try:
            kill_selenium_processes()
        except Exception:
            pass
        print("✅ [시스템] 파이썬 프로그램을 완전히 종료합니다.")
    finally:
        # sys.exit() 대신 os._exit()을 사용하여 대기 중인 다른 스레드 무시하고 즉시 종료.
        # try 블록 안에서 무슨 일이 있었든(정상 완료든 예상 못 한 예외든)
        # 이 지점에는 반드시 도달한다 — _cleanup_in_progress가 True로 남은 채
        # 프로세스만 계속 살아있는 상태를 만들지 않는다.
        os._exit(0)


# (Windows 콘솔 X 버튼 감지용 핸들러)
def console_ctrl_handler(ctx, ctrl_type):
    if ctrl_type in (
        win32con.CTRL_C_EVENT,
        win32con.CTRL_BREAK_EVENT,
        win32con.CTRL_CLOSE_EVENT,
    ):
        cleanup_and_exit(ctx)
        return True
    return False


def kill_selenium_processes():
    """
    일반 크롬은 살려두고, 셀레니움이 띄운 크롬과 드라이버만 추적해서 암살하는 함수
    """
    print("🧹 [시스템] 셀레니움 전용 크롬 프로세스만 선별하여 정리합니다...")

    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            name = proc.info["name"]
            cmdline = proc.info["cmdline"]

            if not name:
                continue

            name_lower = name.lower()

            # 1. 크롬 드라이버(chromedriver.exe)는 무조건 사살 (사람이 쓸 일이 없음)
            if "chromedriver" in name_lower:
                proc.kill()
                continue

            # 2. 일반 크롬(chrome.exe) 중에서 '우리가 켠 셀레니움 크롬'만 사살
            if "chrome" in name_lower and cmdline:
                cmdline_str = " ".join(cmdline)
                # 관리자님이 코드에서 설정한 '--user-data-dir=chrome_profile' 문자열을 달고 있는지 검사
                if "chrome_profile" in cmdline_str or "--test-type" in cmdline_str:
                    proc.kill()

        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            # 권한이 없거나 이미 죽은 프로세스는 부드럽게 무시
            pass


def browser_watchdog(ctx):
    ctx.logger.info("👀 [시스템] 브라우저 감시자(CCTV) 가동 시작 (탭 크래시 전담 방어)")

    while True:
        try:
            # 1. 정기 리셋(재부팅) 중일 때는 감시 일시 중단
            if ctx.is_browser_resetting:
                time.sleep(3)
                continue

            # 2. 드라이버 객체가 아직 준비되지 않았으면 대기
            if ctx.driver is None or ctx.driver.service.process is None:
                time.sleep(3)
                continue

            # [1] 크롬 프로세스 생존 확인 (작업 관리자에서 튕기거나 강제 종료된 경우)
            process = psutil.Process(ctx.driver.service.process.pid)
            if not process.is_running():
                raise Exception("크롬 프로세스 완전 사망")

            # [2] 🚨 핵심: OOM으로 인한 탭 크래시 ("앗, 이런!") 확인
            # 탭이 터지면 title을 못 읽고 에러를 뿜어냅니다.
            try:
                _ = ctx.driver.title
            except Exception:
                raise Exception("크롬 탭 OOM 크래시(Aw, Snap!) 발생")

        except Exception as e:
            # 🔧 순환 임포트 방지: bot.gooroomee_room이 bot.lifecycle(kill_selenium_processes,
            # build_chrome_options 등)을 임포트하므로, daily_browser_reset은 호출 시점에만 지역 임포트한다.
            from bot.gooroomee_room import daily_browser_reset, try_acquire_browser_reset

            # 🔧 [버그 수정] 원래는 이 지점에서 ctx.is_browser_resetting을
            # 감시자가 직접(락 없이) True로 세팅한 뒤 daily_browser_reset을
            # 호출했다 — daily_browser_reset은 자기 시작 부분에서
            # try_acquire_browser_reset을 호출해 "이미 True인지"를 확인하는데,
            # 감시자가 방금 직접 세팅해 둔 그 True를 보고 "이미 다른 곳에서
            # 재시작이 진행 중"이라고 오판해 즉시 조기 종료했다(경고 로그만
            # 남기고 return) — 이 조기 종료 경로는 finally 블록 밖이라
            # is_browser_resetting이 True로 영구 고정되고, 실제 복구 작업
            # (브라우저 재기동 등)은 전혀 실행되지 않았다. 그 결과 OOM
            # 탭 크래시가 감지될 때마다 자가 복구 자체가 항상 스킵되고,
            # 그 뒤로는 07:15 정기 리셋도 관리자 수동 재시작도 전부 "이미
            # 진행 중"에 막혀 버렸다. 이제 감시자도 daily_browser_reset과
            # 동일한 진입점(try_acquire_browser_reset)으로 원자적으로 확보한
            # 뒤, 성공했을 때만 _already_acquired=True로 넘겨 중복 체크를
            # 건너뛰게 한다 — 이미 다른 경로가 재시작 중이면(정기/수동)
            # 감시자는 그냥 이번 순회를 건너뛰고 다음 5초 뒤 다시 확인한다.
            if try_acquire_browser_reset(ctx):
                err_msg = (
                    f"🚨 [비상] 브라우저 상태 이상 감지: {e}. 자가 복구를 시작합니다."
                )
                ctx.logger.error(f"browser_watchdog() : {err_msg}")
                send_chat_telegram(ctx, ["emergency", [err_msg]])

                # 🚨 비상 상황이므로 is_emergency=True를 전달하여 quit() 무한대기 생략 유도
                threading.Thread(
                    target=daily_browser_reset,
                    args=(ctx,),
                    kwargs={"is_emergency": True, "_already_acquired": True, "trigger": "watchdog_oom"},
                    daemon=True,
                ).start()

        # 저사양 PC의 CPU 부하를 줄이기 위해 5초에 한 번씩만 체크
        time.sleep(5)


# ▲ -------------------------------------------------------------------


def init_directories():
    """프로그램 실행에 필요한 모든 디렉토리를 일괄 생성"""
    directories = [
        "runtime/logs",
        "chrome_profile",
        "runtime/captures/temp",
        "runtime/captures/report",
        "runtime/captures/studylog",
    ]
    for d in directories:
        os.makedirs(d, exist_ok=True)
