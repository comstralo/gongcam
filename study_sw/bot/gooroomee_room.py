import os
import subprocess
import threading
import time

from selenium import webdriver
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import Select, WebDriverWait
from selenium.webdriver.common.by import By

from bot.lifecycle import build_chrome_options, kill_selenium_processes, python_executable
from bot.retry import retry_action
from bot.threads import load_tasks_from_disk, remove_thread_id, set_thread, stop_all_thread


# [MAIN] 레이아웃 관리자
def layout_manager(ctx):
    my_id = "[레이아웃 관리]"

    while not ctx.stop_event.is_set() and my_id in ctx.current_threads:
        try:
            with ctx.lock_element:
                attender_num = int(
                    ctx.driver.find_element(
                        By.CSS_SELECTOR,
                        "div.room-join-count",
                    ).text
                )

            select_layout_selector = None  # CSS Selector를 저장할 변수

            # if attender_num <= 4:
            #     # 4명 이하일 때의 레이아웃 버튼 (5번째 li)
            #     select_layout_selector = "li:nth-of-type(5)"
            #     curr_layout = 4
            # # elif attender_num <= 9:
            # #     # 9명 이하일 때의 레이아웃 버튼 (14번째 li)
            # #     select_layout_selector = "li:nth-of-type(14)"
            # #     curr_layout = 9
            # else:
            #     # 그 이상일 때의 레이아웃 버튼 (22번째 li)
            #     select_layout_selector = "li:nth-of-type(22)"
            #     curr_layout = 16

            # 16인 레이아웃으로 고정
            select_layout_selector = "li:nth-of-type(22)"
            curr_layout = 16
            ctx.curr_layout = curr_layout

            # 레이아웃 변경 필요성이 있을때만 변경처리
            if ctx.last_layout != ctx.curr_layout:
                with ctx.lock_element:
                    print(
                        f"layout_manager() :  ⚙️  레이아웃을 {ctx.last_layout} → {ctx.curr_layout} 으로 변경.  ⚙️"
                    )

                    # 1. 레이아웃 변경 창 열기
                    layout_menu_btn = ctx.wait.until(
                        EC.element_to_be_clickable((By.CSS_SELECTOR, "div.logo > div"))
                    )
                    layout_menu_btn.click()

                    # 2. 레이아웃 목록이 나타날 때까지 기다림
                    layout_items = ctx.wait.until(
                        EC.element_to_be_clickable(
                            (By.CSS_SELECTOR, "div.settingFormBlock.layout > ul")
                        )
                    )

                    # 3. 스터디룸 타입 확인 (무료방 or 유료방 유무)
                    is_free_room = ctx.driver.find_elements(
                        By.CSS_SELECTOR, ".flex-select-btn.free.selected"
                    )
                    is_premium_room = ctx.driver.find_elements(
                        By.CSS_SELECTOR, ".flex-select-btn.premium.selected"
                    )

                    # 무료방이면 변경 X
                    if len(is_free_room) > 0:
                        ctx.study_room_type = "free"
                        # print("무료방")

                    # 유료방이면 변경 O
                    elif len(is_premium_room) > 0:
                        ctx.study_room_type = "premium"
                        # print("프리미엄방")

                        target_layout_btn = WebDriverWait(ctx.driver, 10).until(
                            EC.presence_of_element_located(
                                (By.CSS_SELECTOR, select_layout_selector)
                            )
                        )
                        # 원하는 레이아웃 클릭
                        # target_layout_btn = layout_items.find_element(
                        #     By.CSS_SELECTOR, select_layout_selector
                        # )
                        # target_layout_btn.click()

                        # 2. JavaScript를 실행해 해당 요소가 보이도록 스크롤합니다.
                        # 브라우저가 알아서 스크롤 영역과 위치를 계산해줍니다.
                        ctx.driver.execute_script(
                            "arguments[0].scrollIntoView(true);", target_layout_btn
                        )

                        # 3. 스크롤 후 요소가 클릭 가능해지면 클릭합니다.
                        WebDriverWait(ctx.driver, 10).until(
                            EC.element_to_be_clickable(target_layout_btn)
                        ).click()

                    # 4. '확인' 버튼 클릭
                    apply_btn = ctx.wait.until(
                        EC.element_to_be_clickable(
                            (By.CSS_SELECTOR, "button.grm-btn.ok.only")
                        )
                    )
                    apply_btn.click()

                    ctx.last_layout = ctx.curr_layout

        except Exception as e:
            ctx.logger.warning(
                f"layout_manager() :  ⚠️  레이아웃 변경 중 - 에러 발생.  ⚠️\n{e}"
            )

        # 30초마다 레이아웃 변경 체크 & 1초 단위로 종료 신호 체크 (기존 로직 유지)
        for _ in range(30):
            if ctx.stop_event.is_set() or my_id not in ctx.current_threads:
                remove_thread_id(ctx, "[레이아웃 관리]")
                return
            else:  # 종료 이벤트 없으면
                time.sleep(1)  # 1초 대기


# [MAIN] 구루미 스터디룸 접속
# [서브 함수 1] 스터디룸 로그인 전담
@retry_action(task_name="스터디룸 로그인", send_emergency=True)
def _login_studyroom(ctx):
    setting_url = "https://gooroomee.com/%EA%B3%B5%EB%B6%80%ED%95%A9%EC%8B%9C%EB%8B%B9-study#coordi;"
    login_url = "https://gooroomee.com/camstudy/auth/login?"

    ctx.driver.get(setting_url)
    if ctx.driver.current_url.startswith(login_url):
        print("⚠️ [시스템] 스터디룸 로그인 세션 풀림. 로그인을 재시도합니다.")
        id_input_area_e = ctx.wait.until(EC.element_to_be_clickable((By.NAME, "userId")))
        pw_input_area_e = ctx.wait.until(EC.element_to_be_clickable((By.NAME, "passWd")))

        user_id = os.getenv("GOOROOMEE_ID")
        user_pw = os.getenv("GOOROOMEE_PW")

        def fill_field(field_e, value):
            # 필드마다 포커스 -> 지우기 -> 입력을 즉시 이어서 수행해야
            # (자동완성 팝업 등으로 포커스가 옮겨가며 값이 씹히는 것을 방지)
            field_e.click()
            field_e.clear()
            field_e.send_keys(value)
            if field_e.get_attribute("value") != value:
                # React 등 controlled input이 send_keys 이벤트를 놓친 경우,
                # value를 직접 설정하고 input 이벤트를 강제로 발생시켜 프레임워크
                # 상태(state)에 반영되도록 한다.
                ctx.driver.execute_script(
                    """
                    const el = arguments[0];
                    const value = arguments[1];
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(el, value);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    """,
                    field_e,
                    value,
                )

        fill_field(id_input_area_e, user_id)
        fill_field(pw_input_area_e, user_pw)

        login_btn_e = ctx.driver.find_element(By.CSS_SELECTOR, "[class='login-btn']")
        # 채널톡 등 오버레이 위젯이 버튼 위를 순간적으로 덮어
        # 일반 클릭이 가로채이는 경우가 있어, JS 클릭으로 우회한다.
        ctx.driver.execute_script("arguments[0].click();", login_btn_e)
    return True


# [서브 함수 2] 스터디룸 설정 및 입장 전담
@retry_action(task_name="스터디룸 설정 및 입장", send_emergency=True)
def _setup_and_enter_room(ctx):
    setting_url = "https://gooroomee.com/%EA%B3%B5%EB%B6%80%ED%95%A9%EC%8B%9C%EB%8B%B9-study#coordi;"

    ctx.driver.get("https://gooroomee.com/camstudy/")
    ctx.driver.get(setting_url)

    if ctx.driver.current_url.startswith(setting_url):
        # 팝업 닫기
        ctx.wait.until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "[class='clsBtn white']"))
        ).click()
        # 장치 설정 열기
        ctx.wait.until(
            EC.element_to_be_clickable(
                (
                    By.CSS_SELECTOR,
                    "[class='cordi-control-list-item-btn device-setting-btn']",
                )
            )
        ).click()
        # 카메라 선택 (OBS)
        cam_select = Select(
            ctx.wait.until(
                EC.element_to_be_clickable(
                    (By.CSS_SELECTOR, "[class='form-control input-line text-dark']")
                )
            )
        )
        cam_select.select_by_visible_text("OBS Virtual Camera")

        # 좌우반전 해제
        if (
            len(
                ctx.driver.find_elements(
                    By.CSS_SELECTOR, ".cordi-cam-video-mirror-btn.active"
                )
            )
            > 0
        ):
            ctx.wait.until(
                EC.element_to_be_clickable(
                    (By.CSS_SELECTOR, ".cordi-cam-video-mirror-btn.active")
                )
            ).click()

        # 입장 버튼 클릭
        ctx.wait.until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, "[class='btn btn-lg btn-skin cordi-enterRoom-btn']")
            )
        ).click()
    return True


# [MAIN] 구루미 스터디룸 접속 (뼈대만 남은 메인 함수)
def enter_studyroom(ctx, is_recovery=False, force_reload=False):
    if ctx.is_browser_resetting and not is_recovery:
        ctx.logger.warning(
            "🚨 [시스템] 비상 복구가 개입하여 기존 스터디룸 입장 절차를 중단합니다."
        )
        return False

    is_already_in_room = False
    try:
        current_url = ctx.driver.current_url
        join_count_elements = ctx.driver.find_elements(
            By.CSS_SELECTOR, "div.room-join-count"
        )

        # URL에 '#coordi;'가 없고, 참여자 수 UI가 화면에 실제로 '표시(is_displayed)' 되고 있다면 방 내부로 간주
        if (
            "#coordi;" not in current_url
            and len(join_count_elements) > 0
            and join_count_elements[0].is_displayed()
        ):
            is_already_in_room = True
    except Exception:
        pass

    # 🔥 [핵심 로직] 이미 방 안일 때 새로고침 여부 결정
    if is_already_in_room:
        if force_reload:
            ctx.logger.info(
                "enter_studyroom() : 💡 스케줄 시작 또는 오류 복구를 위해 페이지 강제 새로고침(Refresh)을 수행합니다."
            )
            try:
                ctx.driver.refresh()
                time.sleep(2)  # 새로고침 후 DOM이 완전히 날아갈 때까지 잠깐 대기
            except Exception as e:
                ctx.logger.warning(f"새로고침 실패, 일반 입장 절차 진행: {e}")
        else:
            ctx.logger.info(
                "enter_studyroom() : 💡 이미 스터디룸 내부입니다. 불필요한 새로고침(DOM 파괴)을 생략합니다."
            )
            return True
    else:
        # 방 안에 없다면 강제 새로고침 플래그와 무관하게 무조건 로그인 및 입장 절차 밟기
        if not _login_studyroom(ctx):
            return False
        if not _setup_and_enter_room(ctx):
            return False

    # 3. 로딩 스피너 대기 및 메인 페이지 작업 (새로고침을 했든, 새로 들어왔든 공통으로 거쳐야 하는 필수 UI 정리)
    loading_spinner_locator = (By.CSS_SELECTOR, "div.loading-grm-01.size-md")
    loading_container_locator = (By.CSS_SELECTOR, "body > div.room > div:nth-child(6)")

    try:
        ctx.wait.until(EC.visibility_of_element_located(loading_spinner_locator))
        ctx.wait.until(EC.invisibility_of_element_located(loading_spinner_locator))
        ctx.wait.until(EC.invisibility_of_element_located(loading_container_locator))
    except:
        try:
            ctx.wait.until(
                EC.visibility_of_element_located(
                    (By.XPATH, "/html/body/div[1]/div[6]/div/div/div[3]/button")
                )
            ).click()
        except:
            pass

    # 카메라 끄기
    try:
        ctx.wait.until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, "[class='icon-global-camera-off']")
            )
        ).click()
    except:
        pass

    # 팝업 닫기
    try:
        ctx.driver.find_element(
            By.CSS_SELECTOR,
            ".popupDialog.room-alert .popupDialogFooter.btnRec.clearfix .popupFooterBtn.float.half.cancel",
        ).click()
    except:
        pass

    # 스터디 인포 닫기
    try:
        ctx.wait.until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "button.camStudyInfoBtn"))
        ).click()
    except:
        pass

    # 참여자 목록/채팅 사이드 패널 닫기 (입장 시 기본으로 열려 있음)
    try:
        ctx.wait.until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, "[data-type='close'].btn-right-side-toggle")
            )
        ).click()
    except:
        pass

    return True


# 🚨 [핵심 수정] 매개변수 `is_emergency=False` 추가
def daily_browser_reset(ctx, is_emergency=False):
    msg_type = "비상 복구" if is_emergency else "안전 초기화"
    ctx.logger.info(f"🌅 [시스템] 크롬 브라우저 {msg_type} 시작!")

    ctx.is_browser_resetting = True
    ctx.stop_event.set()
    time.sleep(2)
    stop_all_thread(ctx)
    ctx.last_layout = 0

    # 🚨 [추가] 뻗어버린 스레드가 쥐고 죽어버린 자물쇠(Lock)를 강제로 끊어내고 새것으로 교체
    ctx.lock_chat = threading.Lock()
    ctx.lock_element = threading.Lock()
    ctx.logger.info("🔧 [시스템] 스레드 동기화 자물쇠(Lock) 초기화 완료.")

    # 🚨 [핵심 수정] 비상 상황(OOM)일 때는 quit() 시도 시 무한정 멈출 수 있으므로 패스함.
    if not is_emergency:
        try:
            ctx.logger.info("🌅 [시스템] 기존 브라우저를 안전하게 종료합니다...")
            if ctx.driver is not None:
                ctx.driver.quit()
        except Exception as e:
            ctx.logger.warning(f"⚠️ 브라우저 정상 종료 실패 (강제 종료 진행): {e}")
    else:
        ctx.logger.info(
            "🚨 [시스템] OOM 비상 사태! 브라우저 정상 종료를 생략하고 즉시 사살합니다."
        )

    # 좀비 프로세스 확인 사살
    kill_selenium_processes()
    time.sleep(3)

    # 캠 매니저(study_manager_cam_260418.py)도 가끔 뻗는 경우가 있어, 브라우저와
    # 함께 종료 후 재실행한다. 이 서브프로세스는 OBS 가상카메라 송출만 전담하므로
    # 구루미 로그인/스터디룸 로직과는 독립적으로 재시작해도 안전하다.
    try:
        ctx.logger.info("📷 [시스템] 캠 매니저 서브프로세스를 재시작합니다...")
        if ctx.cam_process is not None:
            ctx.cam_process.terminate()
            try:
                ctx.cam_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ctx.cam_process.kill()
        ctx.cam_process = subprocess.Popen(
            [python_executable, "study_manager_cam_260418.py"]
        )
        ctx.logger.info("✅ [시스템] 캠 매니저 서브프로세스 재시작 완료.")
    except Exception as e:
        ctx.logger.warning(f"⚠️ 캠 매니저 재시작 실패(무시): {e}")

    ctx.stop_event.clear()

    try:
        ctx.logger.info(
            "🌅 [시스템] 메모리가 확보되었습니다. 새로운 크롬 브라우저를 엽니다..."
        )
        options = build_chrome_options()
        ctx.driver = webdriver.Chrome(options=options)
        ctx.driver.set_window_size(1920, 1080)
        ctx.driver.set_page_load_timeout(30)
        ctx.wait = WebDriverWait(ctx.driver, 10)

        if enter_studyroom(ctx, is_recovery=True):
            ctx.logger.info(f"✅ [시스템] 브라우저 {msg_type} 및 재입장 완벽 성공!")
            # set_thread(ctx, "[레이아웃 관리]", layout_manager, ())  # 레이아웃 자동 변경 비활성화
            # 구루미 채팅 송수신은 서비스(관리자 페이지)로 대체되어 완전히 제거됨
            # 🚨 [추가] OOM 때문에 중단되었던 작업(집중 관리 등)이 있다면 즉시 다시 불러와서 재개합니다!
            saved_tasks = load_tasks_from_disk(ctx)
            if saved_tasks:
                ctx.logger.info(
                    f"daily_browser_reset() : 💾 OOM으로 중단된 작업 {len(saved_tasks)}개를 즉시 재개합니다."
                )
                from bot.tracking import tracking_capture

                for task in saved_tasks:
                    new_thread_id = (
                        f"[집중 관리 감독(재개)] / [대상자 : {task['target_name']}]"
                    )
                    set_thread(
                        ctx,
                        new_thread_id,
                        tracking_capture,
                        (
                            task["target_name"],
                            task["reason_txt"],
                            task["sender_name"],
                            new_thread_id,
                            task["remaining_count"],
                            task["interval"],
                            task.get("previous_temp_files", []),
                        ),
                    )

            ctx.logger.info("✅ [시스템] 필수 백그라운드 스레드 재가동 완료!")
        else:
            ctx.logger.error(
                "🚨 [비상] 브라우저 재실행 후 스터디룸 입장 실패. 재복구를 유도하기 위해 드라이버를 파괴합니다."
            )
            # 🚨 [추가] 입장에 실패하면 애매하게 켜진 브라우저를 닫아버림
            # -> Watchdog이 프로세스 사망을 감지하고 다시 리셋을 시도하게 만듦 (무한 자가 복구 루프 완성)
            if ctx.driver is not None:
                ctx.driver.quit()
    except Exception as e:
        ctx.logger.error(f"🚨 [비상] 브라우저 초기화 중 에러 발생: {e}")
    finally:
        ctx.is_browser_resetting = False
        ctx.logger.info("👀 [시스템] 브라우저 감시자(CCTV) 감시 재개")
