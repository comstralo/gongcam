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
        # 교시 "시작" 시각마다 schedule_process()가 스터디룸 페이지를 강제
        # 새로고침한다(메모리 확보 목적, is_browser_resetting과는 별개 —
        # 그건 브라우저 프로세스 자체를 재기동하는 07:15 정기 리셋/비상
        # 복구 전용이다). 이 새로고침이 진행되는 동안 캡처(화각 제보 촬영)가
        # 시작되면 끊기므로, 새로고침 시작~완료 구간에는 이 이벤트를 set()해
        # 대기 중인 캡처 시작을 지연시킨다(report_intake.py 참고). 초기값은
        # "새로고침 중이 아님"을 뜻하는 set() 상태 — 시작 직전에 clear(),
        # 완료 직후 set()한다.
        self.period_reload_done = threading.Event()
        self.period_reload_done.set()
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
