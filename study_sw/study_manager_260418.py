# ✅ 1. 파이썬 표준 라이브러리 (Standard Library)
import atexit
import functools
import glob
import os
import signal
import sys
import threading
from datetime import datetime

# 🔧 [로그 강화] Python은 stdout이 터미널(tty)에 연결되어 있을 때만 줄 단위로
# 즉시 내보내고, nohup 등으로 파일에 리다이렉션된 경우(이 봇의 실제 운영
# 방식)에는 약 8KB 블록 단위로 버퍼링한다 — 즉 print()로 남긴 로그(특히
# 좀비 스레드 감지, 재진입 가드 발동처럼 프로세스가 곧 죽거나 이미 불안정한
# 상황에서 남기는 로그)가 버퍼에 쌓인 채로 kill -9/OOM killer에 의해
# 프로세스가 죽으면, 정확히 그 순간을 설명해 줄 마지막 로그 몇 줄이 통째로
# 사라질 수 있었다(사후 진단이 가장 필요한 바로 그 시점에 로그가 없어지는
# 역설). stdout을 강제로 줄 단위 버퍼링으로 재설정해, 이런 print() 출력이
# (이 프로세스가 이미 전부 ctx.logger로 옮겨간 곳들과 별개로, 서드파티
# 라이브러리나 트레이스백처럼 여전히 raw stdout/stderr에 찍히는 것들까지
# 포함해) 매 줄마다 즉시 디스크로 나가게 한다.
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except (AttributeError, ValueError):
    pass

# ✅ 2. 서드파티 라이브러리 (Third-party Libraries)
from dotenv import load_dotenv

load_dotenv()

# ✅ 3. 로컬/커스텀 모듈
# 🔧 [모듈 분리] load_dotenv()가 실행된 뒤에 bot.* 모듈을 임포트해야 한다.
# bot.tunnel과 bot.dashboard_server는 모듈 최상단에서 BOT_SECRET = os.getenv("BOT_SECRET")를
# 평가하므로, load_dotenv() 호출보다 먼저 임포트되면 .env 값을 읽지 못한다.
from bot.dashboard_server import start_dashboard_server
from bot.exit_sync import start_exit_requests_sync
from bot.lifecycle import (
    build_context_and_driver,
    cleanup_and_exit,
    console_ctrl_handler,
    init_directories,
)
from bot.report_intake import start_report_intake
from bot.roster_sync import start_participants_sync
from bot.scheduling import run_scheduler, schedule_process
from bot.threads import recover_inflight_snapshots
from bot.tunnel import start_tunnel_and_register
from bot.usage_tracker import install as install_usage_tracker

# Worker와 이 봇이 같은 Google 서비스 계정을 공유하므로, Sheets API 호출
# 수를 gspread 레벨에서 감싸 Worker의 사용량 모니터링("Bot·Sheet" 탭)에
# 함께 반영되도록 한다. sheets.py가 gspread를 실제로 쓰기 전에 패치해야
# 하므로 다른 bot.* 임포트 직후, 가능한 한 이르게 호출한다.
install_usage_tracker()

# ✅ 4. 운영체제 의존성 모듈 (Windows 전용)
try:
    import win32api
    import win32con

    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False


# MAIN 함수
if __name__ == "__main__":
    # 0. 찌꺼기 임시 파일 청소 (고아 파일 방지)
    init_directories()  # 맨 처음에 딱 한 번 실행

    # 0-1. 컨텍스트 생성 + 로거/캠 서브프로세스/Chrome 드라이버/감시자 스레드 셋업.
    # 모듈을 단순히 import하는 것만으로는 이 셋업이 실행되지 않는다 — 반드시
    # __main__ 진입점에서 명시적으로 호출해야 실제 부작용(Chrome 실행 등)이 발생한다.
    ctx = build_context_and_driver()

    # 0-2. [버그 방어] 지난 실행이 정상 종료 절차(atexit/signal)조차 못 타고
    # 즉사했다면(OOM killer, kill -9, 정전 등), 그때 진행 중이던 캡처의
    # 스냅샷이 runtime/captures/inflight/에 남아있다 — 이를 기존 재개 큐로
    # 합류시켜 첫 스케줄이 평소처럼 이어받게 한다(threads.py 참고).
    # 🔧 [버그 수정] 원래는 이 호출 전에 runtime/captures/temp/*.png를
    # 무조건 전부 지웠다 — 그런데 이 스냅샷이 가리키는 previous_temp_files가
    # 바로 그 temp 폴더 안에 있는 이미지들이라, 정작 이 기능이 필요한 상황
    # (진짜 즉사 후 재시작)에서 복구 큐가 참조하기도 전에 이미지 파일부터
    # 먼저 삭제돼 즉사 방어 기능 자체가 스스로 무력화됐다. 이제 먼저 복구를
    # 실행해 "보존해야 할 파일 목록"을 받은 뒤, temp 청소 시 그 파일들만
    # 제외하고 지운다 — 방금 재개 큐로 옮긴 진행 중 캡처는 살아남고, 그
    # 외의 진짜 고아 파일(재개 큐에 연결되지 않은 것들)은 그대로 청소된다.
    preserved_temp_files = recover_inflight_snapshots(ctx)

    if os.path.exists("runtime/captures/temp"):
        for f in glob.glob("runtime/captures/temp/*.png"):
            if f in preserved_temp_files:
                continue
            try:
                os.remove(f)
            except:
                pass

    # 1. 파이썬 정상 종료 시 무조건 실행되도록 등록
    atexit.register(functools.partial(cleanup_and_exit, ctx))

    # 2. 터미널(Ctrl+C 등) 신호 감지
    # signal 핸들러는 (signum, frame)으로 호출되므로, ctx를 첫 인자로 미리 묶어둔다.
    signal.signal(signal.SIGINT, functools.partial(cleanup_and_exit, ctx))
    signal.signal(signal.SIGTERM, functools.partial(cleanup_and_exit, ctx))

    # 2-1. macOS/Linux: 터미널 창을 닫거나 SSH 세션이 끊기면 SIGHUP이 온다.
    # (Windows에는 SIGHUP이 없으므로 hasattr로 안전하게 가드)
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, functools.partial(cleanup_and_exit, ctx))

    # 3. Windows 콘솔 창 X버튼 닫힘 감지
    if HAS_WIN32:
        win32api.SetConsoleCtrlHandler(functools.partial(console_ctrl_handler, ctx), True)

    try:
        # 🚨 [수정] 스케줄러에 등록하지 말고, 프로그램 시작 즉시 1회성 스레드로 셋업을 실행합니다.
        tmp_period_time = (datetime.now()).strftime("%H:%M")
        threading.Thread(
            target=schedule_process,
            args=(ctx, "임시", tmp_period_time, "1", "period_tmp"),
            daemon=True,
        ).start()

        # ✅ [원격 제어] 관리자 웹앱(BOT · SHEET 탭)에서 상태 확인/재시작이
        # 가능하도록 로컬 상태 서버를 띄우고, Cloudflare Tunnel로 외부에 노출한다.
        start_dashboard_server(ctx)
        start_tunnel_and_register(ctx)

        # ✅ [참여자 명단 동기화] 관리자 웹앱의 "제보" 페이지가 대상 참여자
        # 드롭다운을 채울 수 있도록 접속 명단을 주기적으로 Worker에 전송한다.
        start_participants_sync(ctx)

        # ✅ [퇴실 예약 동기화] 마지막 참여일이 지난 퇴실 신청 회원의 시트
        # 기록을 건너뛰기 위해, exitDate 목록을 주기적으로 Worker에서 가져온다.
        start_exit_requests_sync(ctx)

        # ✅ [웹 제보 수신] 관리자 웹앱에서 접수된 제보를 주기적으로 가져와
        # 실제 화면 캡처(tracking_capture)를 시작한다.
        start_report_intake(ctx)

        print(f"schedule_reserve() : ⏰ ({tmp_period_time}) 임시 스케줄링 등록. ⏰")
        run_scheduler(ctx)
    except KeyboardInterrupt:
        cleanup_and_exit(ctx)
    finally:
        cleanup_and_exit(ctx)
