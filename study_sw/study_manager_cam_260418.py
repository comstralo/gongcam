import csv
import time
import datetime
import os
import pyvirtualcam
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# 설정 상수
FONT_PATH = "./assets/NanumGothic.ttf"
TIMETABLE_FILE = "./assets/timetable.csv"
DDAY_FILE = "./assets/dday.csv"  # ✅ 디데이 설정 파일 경로 추가
WIDTH, HEIGHT = 1920, 1080
RELOAD_INTERVAL = 60  # ⏳ 60초마다 timetable.csv 및 dday.csv 다시 로드


# ✅ 하드코딩 되어있던 D_DAY_EVENTS 리스트를 삭제하고, 파일에서 읽어오는 함수 추가
def load_dday_events():
    """CSV 파일에서 디데이 읽기"""
    events = []
    try:
        # 파일이 없으면 기본 템플릿 파일 생성
        if not os.path.exists(DDAY_FILE):
            os.makedirs(os.path.dirname(DDAY_FILE), exist_ok=True)
            with open(DDAY_FILE, "w", encoding="utf-8") as f:
                f.write("제목,날짜\n국가직 9급,2026-04-04\n지방직 9급,2026-06-20\n")

        with open(DDAY_FILE, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                dt = datetime.datetime.strptime(row["날짜"], "%Y-%m-%d").date()
                events.append({"title": row["제목"], "date": dt})
    except Exception as e:
        print(f"⚠️ 디데이 파일 오류: {e}")

    # 파일이 비어있거나 에러가 나면 프로그램 튕김을 막기 위해 기본값 부여
    if not events:
        events = [{"title": "디데이 설정 확인 필요", "date": datetime.date.today()}]

    return events


# 초기 실행 시 1회 로드
D_DAY_EVENTS = load_dday_events()


def generate_timetable():
    """CSV 파일에서 시간표 읽기"""
    timetable = []
    today = datetime.date.today()

    try:
        with open(TIMETABLE_FILE, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                start_time = datetime.datetime.combine(
                    today, datetime.datetime.strptime(row["시작시간"], "%H:%M").time()
                )
                end_time = datetime.datetime.combine(
                    today, datetime.datetime.strptime(row["종료시간"], "%H:%M").time()
                )

                timetable.append(
                    {
                        "교시": row["교시"],
                        "시작시간": start_time,
                        "종료시간": end_time,
                        "분": int(row["분"]),
                    }
                )
        return timetable
    except Exception as e:
        print(f"⚠️ 시간표 오류: {e}")
        return []


def get_current_class(timetable):
    """현재 시간에 맞는 교시를 찾아 반환"""
    now = datetime.datetime.now()

    for idx, entry in enumerate(timetable):
        lesson_start = entry["시작시간"]
        lesson_end = entry["종료시간"]

        if lesson_start <= now <= lesson_end:
            return entry, lesson_end, "교시 진행 중"

        if idx < len(timetable) - 1:
            next_lesson_start = timetable[idx + 1]["시작시간"]
            if lesson_end < now < next_lesson_start:
                return None, next_lesson_start, "쉬는 시간"

    first_lesson_start = timetable[0]["시작시간"] + datetime.timedelta(days=1)
    return None, first_lesson_start, "쉬는 시간"


def calculate_remaining_time(end_time):
    """남은 시간을 계산"""
    now = datetime.datetime.now()
    if end_time and end_time > now:
        delta = end_time - now
        total_seconds = delta.seconds
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60
        seconds = total_seconds % 60

        if hours > 0:
            return f"{hours:02}시 {minutes:02}분 {seconds:02}초"
        return f"{minutes:02}분 {seconds:02}초"

    return "0초"


def get_d_day_info():
    """D-DAY 정보 변경"""
    global D_DAY_EVENTS  # ✅ 전역 변수 참조
    now = datetime.date.today()
    total_seconds = datetime.datetime.now().minute * 60 + datetime.datetime.now().second
    index = (total_seconds // 15) % len(D_DAY_EVENTS)
    event = D_DAY_EVENTS[index]
    delta = event["date"] - now
    return f"{event['title']} D-{delta.days}"


def create_text_image(main_text, sub_text, width, height, is_red=False):
    """텍스트 이미지 생성"""
    bg_color = (255, 0, 0) if is_red else (0, 0, 0)
    image = Image.new("RGB", (width, height), bg_color)
    draw = ImageDraw.Draw(image)

    try:
        main_font = ImageFont.truetype(FONT_PATH, 200)
        sub_font = ImageFont.truetype(FONT_PATH, 100)
    except Exception as e:
        print(f"⚠️ 폰트 오류: {e}")
        return np.array(image)

    # ✅ 중앙 정렬 개선: 여러 줄 텍스트 개별 정렬
    main_lines = main_text.split("\n")  # 줄 단위로 나누기
    total_text_height = sum(
        draw.textbbox((0, 0), line, font=main_font)[3] for line in main_lines
    )

    y = (height - total_text_height) // 2  # 전체 텍스트 그룹의 중앙 배치

    for line in main_lines:
        text_width, text_height = draw.textbbox((0, 0), line, font=main_font)[2:]
        x = (width - text_width) // 2  # 수평 중앙 정렬
        draw.text((x, y), line, font=main_font, fill=(255, 255, 255))
        y += text_height  # 다음 줄로 이동

    # ✅ D-DAY 하단 정렬
    if sub_text:
        try:
            sub_width, sub_height = draw.textbbox((0, 0), sub_text, font=sub_font)[2:]
            sub_x = (width - sub_width) // 2
            sub_y = height - sub_height - 50
            draw.text((sub_x, sub_y), sub_text, font=sub_font, fill=(200, 200, 200))
        except Exception as e:
            print(f"⚠️ 서브 텍스트 오류: {e}")

    return np.array(image)


def main():
    global D_DAY_EVENTS  # ✅ 전역 변수 업데이트 허용
    last_reload_time = 0
    timetable = generate_timetable()

    with pyvirtualcam.Camera(width=WIDTH, height=HEIGHT, fps=30) as cam:
        print("🎥 가상 카메라 시작 (종료: Ctrl+C)")
        try:
            while True:
                now = time.time()

                # ⏳ 60초마다 시간표와 함께 디데이(dday.csv)도 자동 갱신
                if now - last_reload_time > RELOAD_INTERVAL:
                    timetable = generate_timetable()
                    D_DAY_EVENTS = load_dday_events()  # ✅ 파일 실시간 로드 추가
                    last_reload_time = now

                entry, end, status = get_current_class(timetable)
                main_text = ""
                is_red = False

                if status == "교시 진행 중":
                    remaining_time = calculate_remaining_time(end)
                    main_text = f"{entry['교시']} 진행 중\n{remaining_time} 남음"
                else:
                    remaining_time = calculate_remaining_time(end)
                    main_text = f"쉬는 시간\n{remaining_time} 남음"

                remain_sec = (end - datetime.datetime.now()).total_seconds()
                if 0 < remain_sec <= 12:
                    is_red = int(remain_sec) % 2 == 0

                d_day = get_d_day_info()
                frame = create_text_image(main_text, d_day, WIDTH, HEIGHT, is_red)
                cam.send(frame)
                time.sleep(0.1)

        except KeyboardInterrupt:
            print("🛑 카메라 종료")


if __name__ == "__main__":
    main()
