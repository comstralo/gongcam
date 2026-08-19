# 공부합시당 캠스터디 — "도움봇" 구조 문서

원본:
- `study_sw/study_manager_260418.py` (2619줄) — 메인 스크립트, 봇 본체
- `study_sw/study_manager_cam_260418.py` (207줄) — 가상카메라(교시 안내판) 서브 프로세스
- `study_sw/analyze_daily_fines.py` (134줄) — 벌금 산출 근거를 조회만 하는 독립 진단 스크립트

이 문서는 로컬(또는 특정 서버) PC에서 상시 실행되는 Python 자동화 프로그램 "도움봇"의 구조를 코드 기준으로 정리한 것이다. React+Vite 프론트엔드/Cloudflare Worker 백엔드(`frame-checker-worker`)와는 완전히 별개의 프로세스이며, 서로 직접 통신하는 코드는 **현재 없다** (아래 4절 참고).

## 1. 개요

도움봇은 구루미(gooroomee.com) 캠스터디룸에 **Selenium으로 로그인·상주하는 크롬 브라우저 자원봉사 진행자**다. 사람이 할 일을 대신한다:

- 교시(1~14교시) 시작/종료 시각에 맞춰 전체 공지 채팅 발송, 스터디 로그(출석/학습시간) 화면을 열어 스크린샷·파싱 후 구글 스프레드시트(`공부합시당 캠스터디`)에 자동 기록
- 회원의 개인 귓속말(휘스퍼) 채팅을 실시간 감시해 반일휴무 신청, 의무시간(교시제/달성제) 변경 신청, 캠 미착용/화면 미표시 등 **송출 페널티 제보**, 관리자의 **집중 관리(캡처) 감독** 명령을 자동 처리
- 제보/관리 감독 시 대상자의 캠 화면을 일정 간격으로 캡처해 그리드+타임스탬프를 합성한 뒤 텔레그램으로 관리자에게 전송(증거 자료)
- 크롬 탭 크래시·OOM 등 장애를 자체 감시(watchdog)하고 자동 재기동하는 자가복구 기능
- 매일 07:15 브라우저를 통째로 재시작(정기 리셋)해 장시간 구동으로 인한 메모리 누수/성능 저하 방지

기술 스택:
- **Selenium** (`webdriver.Chrome`): 구루미 웹사이트 로그인, 스터디룸 입장, 레이아웃(16인 그리드) 설정, 채팅 송수신, 캠 화면 스크린샷 캡처를 모두 브라우저 자동화로 수행
- **gspread + oauth2client**(서비스 계정): Google Sheets `공부합시당 캠스터디`의 개인 탭(1~15) 및 `집계` 탭 읽기/쓰기
- **schedule**: 교시 시작/종료 및 매일 07:15 정기 리셋을 시각 기반으로 예약
- **threading**: 레이아웃 관리, 채팅 수신, 브라우저 감시(watchdog), 각 스케줄/캡처 작업을 데몬 스레드로 병렬 실행
- **requests**: 텔레그램 Bot API 호출(제보 사진 전송, 긴급 알림) — 그 외 외부 HTTP 호출 없음
- **PIL(Pillow)**: 캡처 이미지 그리드/타임스탬프 오버레이 합성
- **psutil**: 셀레니움이 띄운 크롬/크롬드라이버 프로세스 생존 확인 및 선별 종료
- `pyvirtualcam`(캠 서브 프로세스 전용): OBS Virtual Camera로 교시 진행 상황 안내판 영상을 송출

## 2. 실행 방식

### 진입점 (2582~2619행)

```python
if __name__ == "__main__":
    init_directories()
    ...
    atexit.register(cleanup_and_exit)
    signal.signal(signal.SIGINT, cleanup_and_exit)
    signal.signal(signal.SIGTERM, cleanup_and_exit)
    if HAS_WIN32:
        win32api.SetConsoleCtrlHandler(console_ctrl_handler, True)

    try:
        threading.Thread(target=schedule_process, args=("임시", tmp_period_time, "1", "period_tmp"), daemon=True).start()
        run_scheduler()
    except KeyboardInterrupt:
        cleanup_and_exit()
    finally:
        cleanup_and_exit()
```

- 스크립트 로드 시점(파일 최상단, 함수 밖)에 이미 크롬 드라이버(`driver = webdriver.Chrome(...)`, 190행)와 브라우저 watchdog 스레드(325행)가 즉시 기동된다. 또한 58행에서 `subprocess.Popen`으로 `study_manager_cam_260418.py`를 별도 프로세스로 곧바로 실행한다.
- `if __name__ == "__main__":` 블록은 디렉토리 초기화, 종료 핸들러 등록, 그리고 **즉시 1회성 임시 스케줄**을 실행한 뒤 `run_scheduler()`(852행)로 진입해 무한루프를 돈다.

### 상시 루프 여부

- `run_scheduler()`(852~867행): `while True:`로 `schedule.run_pending()`을 0.5초 간격으로 계속 호출하는 **상시 루프**. 이것이 프로세스의 메인 스레드를 점유하며 프로그램이 종료되지 않는 한 영원히 실행된다.
- `browser_watchdog()`(271~319행): 별도 데몬 스레드에서 5초 간격으로 크롬 프로세스 생존 및 탭 크래시(`driver.title` 접근 실패)를 감시. 이상 감지 시 `daily_browser_reset(is_emergency=True)`를 새 스레드로 실행해 자가복구.
- `layout_manager()`(1029~1146행), `receive_chat()`(1929~2261행): 교시 시작/종료 시마다 새로 기동되는 데몬 스레드로, 각각 30초·1.5초 주기로 폴링 루프를 돈다.
- `schedule` 라이브러리로 매일 07:15 `daily_browser_reset()`(브라우저 완전 재시작), 각 교시 시작/종료 시각마다 `schedule_process()`가 예약되어 있다(`schedule_reserve()`, 809~848행).

### 종료 처리

- `cleanup_and_exit(signum=None, frame=None)`(196~219행): 캠 서브프로세스 종료(`cam_process.terminate()`) → 크롬 정상 종료(`driver.quit()`) → `kill_selenium_processes()`로 셀레니움이 띄운 잔여 크롬/크롬드라이버 프로세스만 선별 강제 종료 → `os._exit(0)`으로 즉시 프로세스 종료.
- 3중으로 등록되어 있다: `atexit.register(cleanup_and_exit)`(정상 종료), `signal.signal(SIGINT/SIGTERM, cleanup_and_exit)`(Ctrl+C, kill 신호), `win32api.SetConsoleCtrlHandler(console_ctrl_handler, True)`(Windows 콘솔 X 버튼 클릭 감지, `HAS_WIN32`일 때만).
- 즉, 이 봇은 Windows 환경(콘솔 창)에서 상시 구동을 전제로 설계되어 있다(`win32api`/`win32con` import, N5105 CPU 대상 크롬 옵션 주석 등).

## 3. 핵심 기능 목록

| 함수 | 대략 줄 번호 | 역할 |
|---|---|---|
| `retry_action` (데코레이터) | 61~89 | 함수 실패 시 최대 4회 재시도, 최종 실패하면 텔레그램 긴급 알림 |
| `DailyLogHandler` | 93~115 | 자정에 로그 파일명을 날짜별로 자동 교체하는 커스텀 로깅 핸들러 |
| `cleanup_and_exit` / `console_ctrl_handler` | 196~231 | 프로세스 종료 시 브라우저/서브프로세스 정리 |
| `kill_selenium_processes` | 238~268 | 일반 크롬은 살려두고 `data_study_manager` 프로필로 뜬 셀레니움 크롬만 선별 종료 |
| `browser_watchdog` | 271~319 | 크롬 프로세스 생존·탭 크래시(OOM) 감시, 이상 시 자가복구 트리거 |
| `_parse_time_string` / `convert_time_minutes` / `convert_time_24H` / `get_part_percentage` | 362~404 | "N시간 M분" 문자열 ↔ 분/24시간 표기 변환, 참여율 계산 |
| `remove_special_char` | 407~411 | 구루미 닉네임에서 한글/숫자 외 문자(이모지 등) 제거 |
| `check_attend` / `get_korean_day` | 414~435 | 오늘 출석 여부 판정, 한국어 요일 문자열 반환 |
| `get_today_cell` | 438~468 | 요일·교시로부터 스프레드시트 셀 주소(시작/종료/참여율/출석/기록시점/반휴 등)를 계산 |
| `get_member_sheetname` / `_get_member_sheet_map` | 471~480, 1600~1608 | 구루미 닉네임 → 개인 탭 번호(1~15) 매핑 |
| `check_time_proximity` | 483~531 | 교시 시작/종료 2분 이내에는 채팅 명령 수신을 막기 위한 시간 검사 |
| `save_task_to_disk` / `load_tasks_from_disk` | 548~584 | 중단된 캡처 작업을 `task_memory.json`에 백업/복원 (8절 참고) |
| `set_thread` / `remove_thread_id` / `stop_all_thread` | 587~669 | 이름 있는 데몬 스레드 풀 관리(중복 실행 방지, 안전 종료) |
| `send_chat_gooroomee` | 673~757 | 구루미 채팅창에 전체/개인/교시알림 메시지 전송 (Selenium `Select` + `ActionChains`) |
| `send_chat_telegram` / `_send_telegram_report` / `_send_telegram_emergency` | 760~800 | 텔레그램 Bot API로 제보 스크린샷 전송, 긴급 오류 메시지 전송 |
| `schedule_reserve` / `run_scheduler` / `schedule_process` | 809~1021 | `timetable.csv` 기반 교시별 스케줄 등록·실행, 지연 스케줄 방어(10분 초과 시 스킵) |
| `layout_manager` | 1029~1146 | 참여 인원에 맞춰 구루미 화면 레이아웃(현재는 16인 고정)을 자동 변경 |
| `_login_studyroom` / `_setup_and_enter_room` / `enter_studyroom` | 1150~1324 | 구루미 로그인, 카메라 장치(OBS Virtual Camera) 선택, 좌우반전 해제, 스터디룸 입장/새로고침 |
| `daily_browser_reset` | 1328~1415 | 매일 07:15(또는 비상 시) 브라우저를 완전히 재시작하고 중단 작업을 재개 |
| `get_studylog` | 1420~1484 | 구루미 학습 로그 팝업을 열어 스크린샷 저장 후 회원별 출석/학습시간 파싱 |
| `open_google_spreadsheet` | 1488~1501 | 서비스 계정으로 구글 스프레드시트(`GOOGLE_SHEET_NAME`) 연결 |
| `_process_holiday_use` | 1505~1567 | 반일휴무 신청(중복/초과/잔여량 검증) 처리 및 시트 기록 |
| `_process_goaltime` | 1571~1595 | 의무시간(교시제/달성제) 변경 신청 처리 및 시트 기록 |
| `_update_member_studylog` | 1614~1775 | 개인 탭에 교시 시작/종료 시각, 참여율, 최종 기록시각을 기록(목표시간·반휴 반영 계산 포함) |
| `set_sheet` | 1778~1921 | `write_studylog`/`write_holiday_use`/`write_goaltime` 라우팅 후 시트 반영 |
| `receive_chat` | 1929~2261 | 구루미 귓속말 채팅을 1.5초마다 폴링, 반휴/의무시간/제보/관리 명령을 파싱해 라우팅 |
| `tracking_capture` | 2265~2566 | 대상자 캠 화면을 지정 간격·횟수만큼 캡처해 그리드 이미지로 합성, 6장 단위로 텔레그램 전송, 중단 시 임시 파일 백업 |
| `init_directories` | 2569~2579 | 실행에 필요한 로그/스크린샷/임시 디렉토리 일괄 생성 |

## 4. 외부 연동

### 구글 스프레드시트

- 대상 시트: `.env`의 `GOOGLE_SHEET_NAME`(`공부합시당 캠스터디`), 서비스 계정 키는 `resource/sheetAccessKey.json`
- 다루는 탭: **개인 탭(1~15)** — 요일별 교시 시작/종료/참여율, 반휴 사용, 기록시점, 목표시간(O3) 등을 읽고 씀. **`집계` 탭** — 닉네임→시트번호 매핑(B4:C18 범위), 반휴/의무시간 신청 처리 결과를 O열/N열에 기록.
- `SHEET_STRUCTURE.md`에 정리된 셀 배치(예: `ROW_RECORD_TIME=22`, `ROW_TOTAL_FINE=28` 등)와 `get_today_cell()`이 계산하는 셀 주소가 정확히 대응된다. 도움봇은 이 시트의 **최전선 데이터 입력자**이고, `appscript.js`(자정 마감 집계 등)는 그 뒤를 이어받아 정산을 확정하는 역할 분담이다.

### 로그인 대상 웹사이트

- **gooroomee.com**(`https://gooroomee.com/camstudy/...`) — 구루미 캠스터디룸. `.env`의 `GOOROOMEE_ID`/`GOOROOMEE_PW`로 세션이 풀렸을 때만 재로그인(`_login_studyroom`).

### requests로 호출하는 URL

- `https://api.telegram.org/bot{token}/sendDocument` — 제보/관리감독 캡처 이미지 전송
- `https://api.telegram.org/bot{token}/sendMessage` — 긴급 오류 메시지 전송
- **`frame-checker-worker.comstralo.workers.dev` 관련 호출은 현재 코드에 없음.** `PARTICIPANTS_SYNC_INTEGRATION.md`(별도 안내 문서)에 이 Worker로 실시간 참여자 명단을 PUT 전송하는 통합 방안이 제안되어 있으나, `study_manager_260418.py`에는 아직 적용되지 않은 상태다(`grep` 결과 `requests.post`만 2건 존재, 모두 텔레그램용).

### 메신저 연동

- **텔레그램**만 연동되어 있다(Bot API, `.env`의 `TELEGRAM_TOKEN`/`TELEGRAM_CHAT_ID`). 카카오톡/디스코드 연동 코드는 없음.
- 구루미 자체 채팅(전체 공지/귓속말)도 별도 채널로 사용되지만 이는 "메신저 연동"이 아니라 Selenium으로 구루미 UI를 직접 조작하는 것이다.

## 5. 상태 확인 가능성 (외부에서 "실행 중인지" 아는 기존 수단)

**없음.** 코드 전체를 확인한 결과:
- 별도 포트를 열어 헬스체크에 응답하는 서버 코드 없음
- 상태 파일을 주기적으로 갱신하는 하트비트 로직 없음(`task_memory.json`은 캡처 중단 시에만 임시로 쓰이고 재개 시 바로 비워지는 작업 큐일 뿐, 상시 상태 파일이 아님 — 8절 참고)
- 로그 파일(`logs/YYYY-MM-DD.log`)은 남지만, 이는 사후 확인용이지 실시간 "살아있음"을 외부에서 조회할 수 있는 API/엔드포인트가 아님
- 결론: 현재 이 프로세스가 실행 중인지 여부를 프론트엔드/Worker 등 외부 시스템에서 알 방법은 코드상 전혀 없다. (구글 시트에 교시별 기록이 갱신되고 있는지를 간접 정황으로 유추하는 것이 유일한 방법)

## 6. 원격 제어 가능성 (외부에서 정지/재시작 명령)

**없음.** 코드 전체를 확인한 결과:
- 외부 명령을 수신하는 소켓/HTTP 리스너 없음(`socket` 모듈은 import만 되어 있고 실제 서버 바인딩 코드 없음)
- 구루미 채팅 명령(`반휴`, `교시`/`달성`, `제보`, `관리`)은 모두 **스프레드시트 기록/캡처 감독 등 스터디 운영 기능**을 트리거하는 것이며, 봇 프로세스 자체를 정지·재시작시키는 명령은 존재하지 않는다.
- 브라우저 재시작은 (a) 매일 07:15 스케줄, (b) `browser_watchdog`가 이상을 감지했을 때만 자동 트리거되며, 둘 다 **외부 신호가 아닌 내부 조건**에 의한 것이다.
- 프로세스를 멈추려면 물리적으로 콘솔에서 Ctrl+C를 누르거나 OS 프로세스를 강제 종료하는 수단(작업 관리자, `kill` 등)만 가능하다. 원격에서 안전하게 정지/재시작시킬 수 있는 기존 인터페이스는 없다.

## 7. `study_manager_cam_260418.py` / `analyze_daily_fines.py`의 역할

### `study_manager_cam_260418.py`

- 메인 스크립트가 **`subprocess.Popen()`으로 직접 실행하는 자식 프로세스**다(58행: `cam_process = subprocess.Popen([python_executable, "study_manager_cam_260418.py"])`). `import`되어 함수가 호출되는 구조가 아니라, 완전히 독립된 Python 프로세스로 별도 실행된다.
- `pyvirtualcam`으로 **OBS Virtual Camera**에 "N교시 진행 중 / 남은 시간" 또는 "쉬는 시간" 안내판 영상(1920x1080)을 실시간 생성해 송출한다. `resource/timetable.csv`(60초마다 재로드)로 교시 시간표를, `resource/dday.csv`로 시험 D-day 목록을 읽어 15초마다 번갈아 하단에 표시한다.
- 메인 스크립트의 `_setup_and_enter_room()`(1196~1203행)이 구루미 카메라 장치로 정확히 이 "OBS Virtual Camera"를 선택하므로, 두 프로세스는 "캠 영상 생성(cam 스크립트) → 구루미에 그 화면을 송출(메인 스크립트가 Selenium으로 카메라 소스 선택)"이라는 파이프라인으로 연결된다.
- 메인 프로세스 종료 시 `cleanup_and_exit()`(199~204행)이 `cam_process.terminate()`로 이 자식 프로세스도 함께 종료시킨다.

### `analyze_daily_fines.py`

- 메인 스크립트와 **import 관계도, 실행 관계도 없는 완전 독립 스크립트**다. `study_manager_260418.py`에서 이 파일을 참조하는 코드는 없다.
- 스크립트 상단 docstring에 명시된 대로 **읽기 전용 조회 도구**: 개인 탭(1~15)을 순회하며 요일별 '일간 총 벌금'이 어떤 근거(목표시간 벌금 + 오전 벌금, 상한 ₩3,000 적용 여부, 기록시점이 23:30대인지에 따른 확정/미확정)로 산출됐는지 사람이 읽을 수 있는 설명 문자열로 출력한다.
- 시트를 수정하는 코드가 전혀 없어(`worksheet.update` 등 쓰기 호출 없음), 도움봇이 실제로 기록한 벌금 데이터를 사후에 검증/디버깅하기 위한 **진단용 CLI 스크립트**로 보인다. 필요할 때 수동으로 `python analyze_daily_fines.py` 형태로 실행하는 용도.

## 8. `task_memory.json`의 용도

- 실제 내용을 열어본 결과 **현재 0바이트(빈 파일)**다. 즉 지금 이 순간 백업된 미완료 작업이 없는 정상 상태.
- 코드 흐름(`save_task_to_disk`/`load_tasks_from_disk`, 548~584행)으로 보면 이 파일은 **캡처(집중 관리/제보 감독) 작업이 브라우저 재시작 등으로 중단됐을 때 이어서 재개하기 위한 임시 작업 큐**다:
  1. `tracking_capture()`가 목표 횟수를 다 채우기 전에 `stop_event`가 걸리거나(브라우저 재시작 등) 스레드가 강제 정리되면(2528~2550행), 지금까지 찍은 스크린샷을 `temp_captures/`에 낱장으로 저장하고 `{target_name, reason_txt, sender_name, remaining_count, interval, previous_temp_files}` 형태의 딕셔너리를 `save_task_to_disk()`로 이 파일에 append한다.
  2. `daily_browser_reset()`(1378~1400행) 또는 `schedule_process()`(994~1020행)가 브라우저 재입장에 성공한 직후 `load_tasks_from_disk()`를 호출해 파일 내용을 읽고 **즉시 파일을 빈 문자열로 초기화**한 뒤, 저장돼 있던 각 작업을 `tracking_capture` 스레드로 재기동한다.
  3. 즉 이 파일은 상시 상태 기록/하트비트가 아니라, **"캡처 작업이 중단된 그 순간에만 잠깐 채워졌다가 다음 재시작 때 바로 소비되어 비워지는" 일회성 복구 큐**다. 평상시(정상 운영 중)에는 항상 비어 있는 것이 정상이다.
