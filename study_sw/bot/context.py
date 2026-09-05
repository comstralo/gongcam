import threading


class BotContext:
    """
    봇이 사용하는 모든 가변 상태(브라우저, 락, 스레드 목록, 로거 등)를
    하나로 묶는 컨테이너. 기존에는 모듈 전역 변수로 흩어져 있던 상태를
    명시적으로 함수 간에 전달하기 위해 도입되었다.
    """

    def __init__(self):
        self.driver = None
        self.wait = None
        self.logger = None
        self.timetable_df = None
        self.current_threads = {}
        self.stop_event = threading.Event()
        self.lock = threading.Lock()
        self.lock_chat = threading.Lock()
        self.lock_element = threading.Lock()
        self.file_lock = threading.Lock()
        self.is_browser_resetting = False
        self.last_layout = 0
        self.curr_layout = 0
        self.study_room_type = None
        self.cam_process = None
        self.STATE_FILE = "task_memory.json"
        # 마지막 참여일이 지난 퇴실 신청 회원을 걸러내기 위한 캐시
        # ({"4": "2026-09-02", ...}, 시트번호(문자열) -> exitDate). exit_sync가
        # 주기적으로 갱신하고, sheets.py의 기록 루프가 이 값을 읽어 스킵 여부를
        # 판단한다.
        self.exit_requests = {}
