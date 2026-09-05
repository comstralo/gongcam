import re
from datetime import datetime, timedelta

import pandas as pd


def generate_test_schedule(class_range=14, study_time=3, break_time=1):
    current_time = datetime.now() + timedelta(minutes=1)

    timetable = []
    for i in range(1, class_range + 1):
        start_time = current_time + timedelta(
            minutes=(i - 1) * (study_time + break_time)
        )
        end_time = start_time + timedelta(minutes=study_time)
        timetable.append(
            [
                f"{i}교시",
                start_time.strftime("%H:%M"),
                end_time.strftime("%H:%M"),
                study_time,
            ]
        )

    return pd.DataFrame(timetable, columns=["교시", "시작시간", "종료시간", "분"])


def _parse_time_string(time_str):
    h_match = re.search(r"(\d+)\s*시간", time_str)
    m_match = re.search(r"(\d+)\s*분", time_str)

    hours = int(h_match.group(1)) if h_match else 0
    minutes = int(m_match.group(1)) if m_match else 0
    return hours, minutes


def convert_time_minutes(time_str):
    h, m = _parse_time_string(time_str)
    return h * 60 + m


def convert_time_24H(time_str):
    h, m = _parse_time_string(time_str)
    return f"{h:02}:{m:02}"


def get_part_percentage(time_a, time_b, period_minute):
    def time_to_minutes(time_str):
        hours, minutes = map(int, time_str.split(":"))
        return hours * 60 + minutes

    minutes_a = time_to_minutes(time_a)
    minutes_b = time_to_minutes(time_b)

    if period_minute == 0:
        return 100

    percentage = round((abs(minutes_b - minutes_a) / period_minute) * 100)
    if percentage > 100:
        percentage = 100

    return percentage


def remove_special_char(input_string):
    return re.sub(r"[^가-힣0-9]", "", input_string)


def check_attend(date_string):
    input_date = datetime.strptime(date_string, "%Y-%m-%d %H:%M:%S")
    today = datetime.today().date()
    return input_date.date() == today


def get_korean_day():
    today = datetime.today().weekday()
    korean_days = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"]
    return korean_days[today]


def get_today_cell(day_name, period_name):
    days = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"]
    if day_name not in days:
        return f"잘못된 요일: {day_name}"

    day_idx = days.index(day_name)

    try:
        period = int(period_name.replace("교시", ""))
        if not (1 <= period <= 14):
            return "교시 번호는 1부터 14까지입니다."
    except ValueError:
        return "교시 이름은 'N교시' 형식이어야 합니다."

    # 🚀 수학적 규칙: 알파벳 'C'는 아스키코드 67. 요일이 바뀔 때마다 3칸씩 이동!
    base_ascii = 67 + (day_idx * 3)
    col_start = chr(base_ascii)
    col_end = chr(base_ascii + 1)
    col_part = chr(base_ascii + 2)

    return (
        f"{col_start}{5 + period}",  # start_cell
        f"{col_end}{5 + period}",  # end_cell
        f"{col_part}{5 + period}",  # part_cell
        f"{col_start}22",  # attendance_cell
        f"{col_start}23",  # final_record_cell
        f"{col_start}26",  # total_time_cell
        f"{col_start}20",  # holiday_normal_cell
        f"{col_start}21",  # holiday_reason_cell
    )


def check_time_proximity(timetable_df):
    """
    향후 가장 가까운 수업 시작/종료 시간 2분 전인지 확인합니다.
    2분 이내로 다가왔다면 False, 그렇지 않다면 True를 반환합니다.
    """
    try:
        now = datetime.now()
        two_minutes = timedelta(minutes=2)

        future_times = []
        for _, row in timetable_df.iterrows():
            start_time_obj = datetime.strptime(row["시작시간"], "%H:%M").time()
            end_time_obj = datetime.strptime(row["종료시간"], "%H:%M").time()

            start_datetime = datetime.combine(now.date(), start_time_obj)
            end_datetime = datetime.combine(now.date(), end_time_obj)

            if start_datetime > now:
                future_times.append(start_datetime)
            if end_datetime > now:
                future_times.append(end_datetime)

        if not future_times:
            return True

        closest_time = min(future_times)
        if (closest_time - now) <= two_minutes:
            return False

        return True

    except FileNotFoundError:
        print("오류: timetable.csv 파일을 찾을 수 없습니다.")
        return True
    except Exception as e:
        print(f"CSV 처리 오류: {e}")
        return True
