import os
import time
from datetime import datetime

import gspread
from oauth2client.service_account import ServiceAccountCredentials
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

from bot.retry import retry_action
from bot.threads import remove_thread_id, set_thread
from bot.utils import (
    check_attend,
    convert_time_24H,
    convert_time_minutes,
    get_korean_day,
    get_part_percentage,
    get_today_cell,
    remove_special_char,
)


# 🔧 순환 임포트 방지: get_studylog의 retry_action fallback_func는 실패 시
# enter_studyroom(bot.gooroomee_room)을 호출해 강제 새로고침을 지시해야 하는데,
# bot.gooroomee_room은 반대로 bot.sheets를 임포트하지 않으므로 실제 순환은 없지만,
# 데코레이터 정의 시점(모듈 로드 시)에 bot.gooroomee_room이 아직 준비되지 않았을 수
# 있으므로 fallback 호출 시점에만 지역 임포트한다.
def _fallback_reload_studyroom(ctx):
    from bot.gooroomee_room import enter_studyroom

    return enter_studyroom(ctx, force_reload=True)


# [ETC] 구루미 사용자명으로 시트 번호 반환
def get_member_sheetname(spreadsheet, member_name):
    names_range = spreadsheet.range("C4:C18")
    nums_range = spreadsheet.range("B4:B18")

    for i, cell in enumerate(names_range):
        if cell.value == member_name:
            return str(nums_range[i].value)  # 일치하는 B 열 값 반환

    return False  # 이름이 일치하는 값이 없을 경우


# [MAIN] 구루미 스터디룸에서 학습로그 수집
# 기존 get_studylog 함수를 지우고 이것만 남깁니다.
@retry_action(
    task_name="스터디 로그 수집",
    send_emergency=True,
    fallback_func=_fallback_reload_studyroom,  # 🔥 수정: 실패 시 강제 새로고침 지시
)
def get_studylog(ctx, period_str, schedule_kind):
    if ctx.is_browser_resetting:
        ctx.logger.warning(
            f"⚠️ 비상 복구 진행 중으로 [{period_str}] 스터디 로그 수집을 생략합니다."
        )
        return False

    with ctx.lock_element:
        # 버튼 클릭 및 로그 요소 추출 (기존 try문 안의 로직을 들여쓰기 풀고 그대로 넣음)
        study_log_open_btn = ctx.wait.until(
            EC.element_to_be_clickable(
                (By.CSS_SELECTOR, "nav > ul:first-of-type > li:first-of-type")
            )
        )
        study_log_open_btn.click()

        study_log_items = ctx.wait.until(
            EC.element_to_be_clickable(
                (
                    By.CSS_SELECTOR,
                    "div.room > div.popupContainer.camstudy-setting > div > div.grm-dialog-body > div:nth-child(1) > ol",
                )
            )
        )

        log_screenshot_dir = "./runtime/captures/studylog"
        study_log_items.screenshot(
            f"{log_screenshot_dir}/{datetime.now().strftime('%y%m%d')}_{period_str}_{'시작' if schedule_kind == 'period_start' else '종료'}.png"
        )

        studylog_list = []
        for li in study_log_items.find_elements(By.TAG_NAME, "li"):
            member_name = remove_special_char(
                li.find_element(By.CSS_SELECTOR, "span:nth-of-type(2)").text
            )
            last_attendance = li.find_element(
                By.CSS_SELECTOR, "span:nth-of-type(4)"
            ).text
            last_studytime = li.find_element(
                By.CSS_SELECTOR, "span:nth-of-type(5)"
            ).text

            if last_attendance != "" and member_name != "도움봇":
                studylog_list.append((member_name, last_attendance, last_studytime))

        closelog_btn = ctx.wait.until(
            EC.element_to_be_clickable(
                (
                    By.CSS_SELECTOR,
                    "div.room >div.popupContainer.camstudy-setting > div > div.grm-dialog-header.clearfix > div > button",
                )
            )
        )
        closelog_btn.click()

    print(f"get_studylog() :  ✅  [{period_str}] 스터디 로그 수집 성공.  ✅")
    return studylog_list


# [MAIN] 스프레드 시트에 기록
# 🔧 [ctx 리팩터] open_google_spreadsheet 자체는 ctx 상태를 쓰지 않지만, retry_action의
# wrapper가 실패 시 ctx.logger에 접근하기 위해 첫 인자로 ctx를 요구하므로 그대로 받는다.
@retry_action(task_name="구글 스프레드시트 접속")
def open_google_spreadsheet(ctx, sheet_name=None):
    if sheet_name is None:
        sheet_name = os.getenv("GOOGLE_SHEET_NAME")

    scope = [
        "https://spreadsheets.google.com/feeds",
        "https://www.googleapis.com/auth/drive",
    ]
    creds = ServiceAccountCredentials.from_json_keyfile_name(
        "./assets/sheetAccessKey.json", scope
    )
    client = gspread.authorize(creds)
    return client.open(sheet_name)


# [서브 함수] 반일휴무 신청 시트 기록 전담
# 🔧 [ctx 리팩터] 이 함수는 get_member_sheetname()만 호출할 뿐 ctx 상태를 직접
# 쓰지 않지만, retry_action wrapper가 ctx.logger에 접근하기 위해 첫 인자로 ctx를 요구한다.
@retry_action(task_name="반일휴무 시트 기록", send_emergency=True)
def _process_holiday_use(
    ctx, spreadsheet, member_name, holiday_kind, holiday_normal_cell, holiday_reason_cell
):
    total_sheet = spreadsheet.worksheet("집계")
    member_sheet_name = get_member_sheetname(total_sheet, member_name)

    if not member_sheet_name:
        return False, f"[↪️답장] {member_name}님의 시트를 찾을 수 없습니다."

    worksheet = spreadsheet.worksheet(member_sheet_name)
    member_row = int(member_sheet_name) + 3

    cells_to_read = ["C44", holiday_normal_cell, holiday_reason_cell]
    read_values = worksheet.batch_get(
        cells_to_read, value_render_option="UNFORMATTED_VALUE"
    )

    holiday_use_remain = read_values[0][0][0] if read_values[0] else 0
    holiday_use_normal_today = read_values[1][0][0] if read_values[1] else 0
    holiday_use_reason_today = read_values[2][0][0] if read_values[2] else 0

    today_holiday_total = holiday_use_normal_today + holiday_use_reason_today
    req = holiday_kind  # 이번에 요청한 장수 (1 or 2)

    # 🚀 [개선 1] 이미 등록된 반휴가 요청한 장수와 같거나 크면 무조건 중복 에러
    if holiday_use_normal_today >= req:
        total_sheet.update([["오류 (중복)"]], f"O{member_row}")
        return (
            False,
            f"[↪️답장] 오류 ➡️ 오늘 [반휴/{holiday_use_normal_today}장] + [사휴/{holiday_use_reason_today}장] 이 이미 등록되어 있어요.",
        )

    # 🚀 [개선 2] 추가로 차감되어야 할 장수 계산 (예: 1장 썼는데 2장 요청하면 1장만 추가 차감)
    additional_req = req - holiday_use_normal_today

    # 1. 일일 최대 사용량(2장) 초과 검사 (오늘 쓴 총량 + 추가할 장수 > 2)
    if today_holiday_total + additional_req > 2:
        total_sheet.update([["오류 (초과)"]], f"O{member_row}")
        return (
            False,
            f"[↪️답장] 오류 ➡️ 하루 최대치(2장)를 초과합니다. (현재 등록된 휴무: 총 {today_holiday_total}장)",
        )

    # 2. 잔여량 부족 검사 (추가로 필요한 장수보다 남은 잔여량이 적은 경우)
    if holiday_use_remain < additional_req:
        total_sheet.update([["오류 (초과)"]], f"O{member_row}")
        return (
            False,
            f"[↪️답장] 오류 ➡️ 남은 반휴 잔여량이 [{holiday_use_remain}장] 이라 신청이 불가해요.",
        )

    # 3. 통과 시 시트 업데이트 (req가 1이든 2든 최종 상태인 req로 덮어쓰기)
    worksheet.update([[req]], holiday_normal_cell)

    # 기존에 1장이 있었는데 2장으로 올리는 거면 "할당", 아예 쌩신규면 "n장" 으로 메시지 구분
    msg_action = "할당" if holiday_use_normal_today > 0 else f"{req}장"
    total_sheet.update([[f"등록 ({msg_action})"]], f"O{member_row}")

    return (
        True,
        f"[↪️답장] [반휴/{req}장] 반영 ➡️ 시트에 정상반영 됐는지 꼭 확인해 주세요! 😊",
    )


# [서브 함수] 의무시간 변경 시트 기록 전담
@retry_action(task_name="의무시간 변경 시트 기록", send_emergency=True)
def _process_goaltime(ctx, spreadsheet, member_name, goaltime_kind):
    total_sheet = spreadsheet.worksheet("집계")
    member_sheet_name = get_member_sheetname(total_sheet, member_name)

    if not member_sheet_name:
        return False, f"[↪️답장] {member_name}님의 시트를 찾을 수 없습니다."

    worksheet = spreadsheet.worksheet(member_sheet_name)
    member_row = int(member_sheet_name) + 3

    worksheet.update([[f"{goaltime_kind}"]], "O3")
    total_sheet.update(
        [
            [
                f'등록 ({goaltime_kind.replace(" (교시제)", "교시").replace(" (달성제)", "달성")})'
            ]
        ],
        f"N{member_row}",
    )

    return (
        True,
        f"[↪️답장] [{goaltime_kind}] 등록 ➡️ 시트에 정상반영 됐는지 꼭 확인해 주세요! 😊",
    )


# [서브 함수] 집계 시트에서 멤버별 시트 번호 매핑 전담
@retry_action(task_name="집계 시트 매핑", send_emergency=True)
def _get_member_sheet_map(ctx, spreadsheet):
    member_sheet_map = {}
    total_sheet = spreadsheet.worksheet("집계")
    names_range = total_sheet.range("C4:C18")
    nums_range = total_sheet.range("B4:B18")
    for idx, cell in enumerate(names_range):
        if cell.value:  # 이름이 비어있지 않은 경우만 매핑
            member_sheet_map[cell.value] = str(nums_range[idx].value)
    return member_sheet_map


# [서브 함수] 멤버 1명의 개별 스터디로그 기록 전담
# 💡 개별 에러 발생 시 알림 폭탄을 막기 위해 send_emergency=False 로 설정
@retry_action(task_name="개별 스터디로그 시트 기록", send_emergency=False)
def _update_member_studylog(
    ctx,
    spreadsheet,
    member_sheet_name,
    member_name,
    last_attendtime,
    last_studytime,
    start_cell,
    end_cell,
    part_cell,
    attendtime_cell,
    writetime_cell,
    studytime_cell,
    holiday_normal_cell,
    holiday_reason_cell,
    schedule_kind,
    period_str,
    period_minute_original,
):
    worksheet = spreadsheet.worksheet(member_sheet_name)

    start_wvalue = None
    end_wvalue = None
    part_wvalue = None
    attendtime_wvalue = last_attendtime
    writetime_wvalue = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    studytime_wvalue = None

    # 시트에서 값 한번에 가져오기
    cells_to_read = [
        start_cell,
        "O3",
        "I3",
        holiday_normal_cell,
        holiday_reason_cell,
        part_cell,
    ]
    read_values = worksheet.batch_get(
        cells_to_read, value_render_option="UNFORMATTED_VALUE"
    )

    start_rvalue = read_values[0][0][0] if read_values[0] else None
    goaltime_rvalue = read_values[1][0][0] if read_values[1] else None
    start_type_rvalue = read_values[2][0][0] if read_values[2] else None
    is_holiday_normal = read_values[3][0][0] if read_values[3] else 0
    is_holiday_reason = read_values[4][0][0] if read_values[4] else 0
    part_rvalue = read_values[5][0][0] if read_values[5] else None

    is_sunday = get_korean_day()

    # 미시작 인원 체크 (에러가 아니므로 정상 처리 후 다음으로 넘어감)
    if isinstance(start_type_rvalue, str) and "-" in start_type_rvalue:
        print(f"[{member_name}] 미시작 인원 (기록 패스)")
        return True

    # 🚀 [개선 1] 의무시간 동적 파싱 (11H, 12H 멤버가 추가되어도 수정 불필요)
    full_goaltime, half_goaltime, period_minute = 0, 0, period_minute_original
    if goaltime_rvalue and "교시제" in goaltime_rvalue:
        try:
            hours = int(goaltime_rvalue.split("H")[0])  # "8H (교시제)"에서 8만 추출
            full_goaltime = hours * 60
            half_goaltime = full_goaltime // 2
            period_minute = 60
        except:
            pass
    elif goaltime_rvalue and "(달성제)" in goaltime_rvalue:
        full_goaltime, half_goaltime, period_minute = 0, 0, 0

    # 🚀 [개선 2] 오늘 채워야 할 '타겟 시간' 수학적 계산 (무식한 elif 제거)
    today_target = full_goaltime
    if is_sunday == "일요일":
        today_target -= half_goaltime  # 일요일이면 절반 깎음

    holiday_total = is_holiday_normal + is_holiday_reason
    today_target -= half_goaltime * holiday_total  # 쓴 휴무 장수만큼 절반씩 깎음

    # 교시 시작 & 금일 출석자
    if schedule_kind == "period_start" and check_attend(last_attendtime) == True:
        start_wvalue = convert_time_24H(last_studytime)
        studytime_wvalue = convert_time_24H(last_studytime)

    # 교시 시작 & 금일 미출석자
    elif schedule_kind == "period_start" and check_attend(last_attendtime) == False:
        start_wvalue, studytime_wvalue = "00:00", "00:00"

    # 교시 종료 & 금일 출석자
    elif schedule_kind == "period_end" and check_attend(last_attendtime) == True:
        if start_rvalue == None:
            start_wvalue, end_wvalue, part_wvalue = "00:00", "00:00", "ERR"
        else:
            part_percentage = get_part_percentage(
                start_rvalue, convert_time_24H(last_studytime), period_minute
            )
            last_studytime_to_minute = convert_time_minutes(last_studytime)

            # 🚀 [개선 3] 수식화된 타겟 시간으로 PASS 여부 단번에 판별
            if today_target <= 0 or last_studytime_to_minute >= today_target:
                if part_percentage != "ERR" and part_percentage < 85:
                    part_percentage = "PASS"

            end_wvalue = convert_time_24H(last_studytime)
            part_wvalue = part_percentage
            studytime_wvalue = convert_time_24H(last_studytime)

    # 교시 종료 & 금일 미출석자
    elif schedule_kind == "period_end" and check_attend(last_attendtime) == False:
        if start_rvalue == None:
            start_wvalue, end_wvalue, part_wvalue = "00:00", "00:00", "ERR"
        else:
            part_percentage = 0

            # 🚀 [개선 3 적용] 미출석자도 타겟 시간이 0 이하(전체 휴무)면 무조건 PASS
            if today_target <= 0:
                part_percentage = "PASS"

            end_wvalue, part_wvalue, studytime_wvalue = (
                "00:00",
                part_percentage,
                "00:00",
            )

    # 달성제 및 페널티 고정 덮어쓰기 (기존 로직 유지)
    if (
        goaltime_rvalue is not None
        and "(달성제)" in goaltime_rvalue
        and schedule_kind == "period_end"
    ):
        part_wvalue = "PASS"

    if part_rvalue == "PEN" and schedule_kind == "period_end":
        part_wvalue = "PEN"

    # 일괄 업데이트 구성
    update_targets = {
        start_cell: start_wvalue,
        end_cell: end_wvalue,
        part_cell: part_wvalue,
        attendtime_cell: attendtime_wvalue,
        writetime_cell: writetime_wvalue,
        studytime_cell: studytime_wvalue,
    }

    update_requests = [
        {"range": cell_range, "values": [[value]]}
        for cell_range, value in update_targets.items()
        if value is not None
    ]

    if update_requests:
        worksheet.batch_update(update_requests)

    # 로그 출력
    if schedule_kind == "period_start":
        ctx.logger.info(
            f"set_sheet() : ✅ [{member_name}] 님의 [{period_str}] [시작] 기록 [{member_sheet_name}번] 시트 기록 결과 - 성공. ✅ \n➡️ 시작 : [{start_wvalue}] / 최근 출석 : [{attendtime_wvalue}] / 최종 기록 : [{writetime_wvalue}] / 일간 학습 : [{studytime_wvalue}]"
        )
    elif schedule_kind == "period_end":
        ctx.logger.info(
            f"set_sheet() : ✅ [{member_name}] 님의 [{period_str}] [종료] 기록 [{member_sheet_name}번] 시트 기록 결과 - 성공. ✅ \n➡️ 종료 : [{end_wvalue}] / 참여도 : [{part_wvalue}%] / 최근 출석 : [{attendtime_wvalue}] / 최종 기록 : [{writetime_wvalue}] / 일간 학습 : [{studytime_wvalue}]"
        )

    time.sleep(1)  # 병목 방지
    return True


def set_sheet(ctx, send_list):
    set_kind = send_list[0]  # 처리할 작업
    set_data = send_list[1]

    # 교시 정보 설정
    if set_kind == "write_studylog":
        period_str = set_data[0]
    else:  # 반휴, 의무시간 신청 작업 시간에도 셀 위치 구하기 위해서.
        period_str = "1교시"

    # 셀 위치 받아오기
    (
        start_cell,
        end_cell,
        part_cell,
        attendtime_cell,
        writetime_cell,
        studytime_cell,
        holiday_normal_cell,
        holiday_reason_cell,
    ) = get_today_cell(get_korean_day(), period_str)

    # ▼ 여기서부터 수정! 엄청 길었던 try/except 반복문이 이렇게 짧아집니다. ▼
    spreadsheet = open_google_spreadsheet(ctx)
    if not spreadsheet:  # 4번 재시도 후에도 실패해서 False가 돌아왔다면
        return False

    if set_kind == "write_studylog":
        period_str = set_data[0]
        schedule_kind = set_data[1]
        period_minute_original = set_data[2]  # 변수명 충돌 방지
        thread_id = set_data[3]

        studylog_list = get_studylog(ctx, period_str, schedule_kind)

        # 로그 수집 실패 시, 작업 종료
        if studylog_list == False:
            remove_thread_id(ctx, thread_id)
            return

        # 🚀 1. 시트 매핑 (데코레이터 자동 적용)
        member_sheet_map = _get_member_sheet_map(ctx, spreadsheet)

        if not member_sheet_map:  # 매핑 최종 실패 시
            ctx.logger.error(
                f"set_sheet() : 🚨 집계 시트 매핑 최종 실패. 작업을 중단합니다."
            )
            remove_thread_id(ctx, thread_id)
            return

        # 🚀 2. 멤버별 기록 (데코레이터 자동 적용)
        for member_name, last_attendtime, last_studytime in studylog_list:
            member_sheet_name = member_sheet_map.get(member_name)

            if not member_sheet_name:  # 시트가 존재하지 않으면
                print(f"⚠️ {member_name}님의 시트를 찾을 수 없습니다. (패스)")
                continue  # 💡 개선: break를 써서 전체를 멈추지 않고 이 사람만 건너뜁니다!

            # 🚪 [마지막 참여일 이후 집계 차단] exit_sync가 채워둔 캐시
            # (ctx.exit_requests, {"번호": "YYYY-MM-DD"})에서 이 회원의
            # exitDate를 찾아, 오늘이 그 날짜보다 늦으면(exitDate 당일까지는
            # 정상 기록, 그 다음날부터 스킵) 시트에 아무것도 쓰지 않는다 —
            # 관리자가 확정 처리를 늦게 하더라도 그 사이 새 결석 기록·벌금이
            # 쌓이지 않게 하기 위함(사용자 지시).
            exit_date = ctx.exit_requests.get(member_sheet_name)
            if exit_date and datetime.now().strftime("%Y-%m-%d") > exit_date:
                print(f"🚪 [{member_name}]님은 마지막 참여일({exit_date})이 지나 기록을 건너뜁니다.")
                continue

            # 멤버 개별 기록 처리 (이 함수 안에서 4번 재시도, 실패해도 다음 사람으로 자연스럽게 넘어감)
            _update_member_studylog(
                ctx,
                spreadsheet,
                member_sheet_name,
                member_name,
                last_attendtime,
                last_studytime,
                start_cell,
                end_cell,
                part_cell,
                attendtime_cell,
                writetime_cell,
                studytime_cell,
                holiday_normal_cell,
                holiday_reason_cell,
                schedule_kind,
                period_str,
                period_minute_original,
            )

        # 전체 작업 정상 완료
        remove_thread_id(ctx, thread_id)
        return

    # write_holiday_use / write_goaltime: 구루미 채팅(반휴·의무시간 신청)으로만
    # 트리거되던 처리였으나, 채팅 송수신 기능 자체가 서비스(관리자 페이지)로
    # 대체되어 완전히 제거됨에 따라 함께 제거됨.
