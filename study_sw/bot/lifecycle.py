import logging
import os
import subprocess
import sys
import threading
import time
from datetime import datetime

import psutil
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait

from bot.telegram import send_chat_telegram

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

    def emit(self, record):
        today = datetime.now().date()
        if today != self.current_date:
            self.stream.close()
            self.baseFilename = datetime.now().strftime(self.filename_pattern)
            self.stream = self._open()
            self.current_date = today
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


# 💡 인자(signum, frame)를 선택적으로 받도록 수정 (atexit 등에서 호출할 때 에러 방지)
def cleanup_and_exit(ctx, signum=None, frame=None):
    print("\n🚨 [시스템] 프로그램 종료 신호 감지! 브라우저를 안전하게 닫습니다.")
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
    except Exception as e:
        pass

    # 프로세스 잔해 완전 박살 (Windows 기준)
    # 주의: 이 명령어는 사용자가 개인적으로 띄워둔 다른 모든 크롬창도 닫아버릴 수 있습니다.
    kill_selenium_processes()
    print("✅ [시스템] 파이썬 프로그램을 완전히 종료합니다.")

    # sys.exit() 대신 os._exit()을 사용하여 대기 중인 다른 스레드 무시하고 즉시 종료
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
            # 상태 이상이 감지되었고, 현재 의도적인 재부팅 상태가 아니라면
            if not ctx.is_browser_resetting:
                # 🚨 [추가] 복구 함수를 부르기 전에 감시자 본인이 직접 플래그를 잠가버립니다.
                ctx.is_browser_resetting = True

                err_msg = (
                    f"🚨 [비상] 브라우저 상태 이상 감지: {e}. 자가 복구를 시작합니다."
                )
                ctx.logger.error(f"browser_watchdog() : {err_msg}")
                send_chat_telegram(ctx, ["emergency", [err_msg]])

                # 🔧 순환 임포트 방지: bot.gooroomee_room이 bot.lifecycle(kill_selenium_processes,
                # build_chrome_options 등)을 임포트하므로, daily_browser_reset은 호출 시점에만 지역 임포트한다.
                from bot.gooroomee_room import daily_browser_reset

                # 🚨 비상 상황이므로 is_emergency=True를 전달하여 quit() 무한대기 생략 유도
                threading.Thread(
                    target=daily_browser_reset,
                    args=(ctx,),
                    kwargs={"is_emergency": True},
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
