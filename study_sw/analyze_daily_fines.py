"""
1~15번 탭을 순회하며 요일별 '일간 총 벌금'이 어떻게 산출됐는지 설명을 출력한다.
읽기 전용 조회 스크립트 (시트를 수정하지 않음).

규칙 (사용자 확인):
  - 일간 총 벌금은 하루 최대 ₩3,000 상한(cap)이 걸린다.
  - '기록시점'이 그날 23:30대여야 그날 벌금이 확정된 값이다.
    (당일 진행 중에는 목표/오전 벌금만 실시간으로 갱신되고 총 벌금은 0으로 유지된다.)
"""

import gspread
from oauth2client.service_account import ServiceAccountCredentials

SHEET_ID = "1jjIo-SulFyonrv2dSFYO4SVsejKgbfogCJLVLbA-0Ao"
KEY_PATH = "assets/sheetAccessKey.json"
DAILY_CAP = 3000

DAYS = ["월", "화", "수", "목", "금", "토", "일"]
DAY_COLS = [2, 5, 8, 11, 14, 17, 20]  # C,F,I,L,O,R,U (0-indexed)

ROW_RECORD_TIME = 22   # 🤖 기록시점
ROW_TOTAL_FINE = 28    # 💰 일간 총 벌금
ROW_GOAL_FINE = 29     # 💰 일간 목표시간 벌금
ROW_MORNING_FINE = 30  # 💰 오전 목표시간 벌금


def parse_won(s):
    return int((s or "").replace("₩", "").replace(",", "") or 0)


def is_confirmed(record_timestamp):
    # "YYYY-MM-DD 23:30:xx" 형태 — 그날 자정 마감 처리가 이미 돌았는지 여부
    return "23:3" in (record_timestamp or "")


def explain_day(total, goal, morning, confirmed):
    combined = goal + morning
    if not confirmed:
        if combined == 0:
            return "진행 전/기록 없음"
        return f"마감 전(미확정) — 현재까지 목표시간 벌금 ₩{goal:,} + 오전 벌금 ₩{morning:,} 예상 중"
    if total == 0:
        if combined == 0:
            return "벌금 없음 (목표 달성)"
        return f"확정되었으나 총 벌금 ₩0 (목표 ₩{goal:,} / 오전 ₩{morning:,} — 규칙상 최종 미부과)"
    if total >= DAILY_CAP and combined > DAILY_CAP:
        return (
            f"상한 적용 — 목표 벌금 ₩{goal:,} + 오전 벌금 ₩{morning:,} = ₩{combined:,}"
            f"이지만 하루 상한 ₩{DAILY_CAP:,}으로 조정되어 ₩{total:,} 확정"
        )
    if total == combined:
        return f"목표 벌금 ₩{goal:,} + 오전 벌금 ₩{morning:,} 그대로 합산되어 ₩{total:,} 확정"
    if total == goal and morning == 0:
        return f"목표시간 벌금 ₩{goal:,}만 부과되어 ₩{total:,} 확정"
    return f"목표 ₩{goal:,} / 오전 ₩{morning:,} 조합으로 ₩{total:,} 확정 (상세 계산식은 앱스크립트 확인 필요)"


def analyze_tab(sh, tab_name):
    ws = sh.worksheet(tab_name)
    values = ws.get_all_values()
    if len(values) <= ROW_MORNING_FINE:
        return None

    name = values[1][1].replace("📝", "").replace("님의 집계표", "").strip()
    goal_type = values[2][14] if len(values[2]) > 14 else ""

    record_row = values[ROW_RECORD_TIME]
    total_row = values[ROW_TOTAL_FINE]
    goal_row = values[ROW_GOAL_FINE]
    morning_row = values[ROW_MORNING_FINE]

    days_out = []
    week_total = 0
    for day, col in zip(DAYS, DAY_COLS):
        record_ts = record_row[col] if col < len(record_row) else ""
        confirmed = is_confirmed(record_ts)
        total = parse_won(total_row[col]) if col < len(total_row) else 0
        goal = parse_won(goal_row[col]) if col < len(goal_row) else 0
        morning = parse_won(morning_row[col]) if col < len(morning_row) else 0

        if confirmed:
            week_total += total

        days_out.append(
            {
                "day": day,
                "confirmed": confirmed,
                "total": total,
                "goal": goal,
                "morning": morning,
                "explain": explain_day(total, goal, morning, confirmed),
            }
        )

    return {
        "tab": tab_name,
        "name": name,
        "goal_type": goal_type,
        "days": days_out,
        "week_total_confirmed": week_total,
    }


def main():
    scope = [
        "https://spreadsheets.google.com/feeds",
        "https://www.googleapis.com/auth/drive",
    ]
    creds = ServiceAccountCredentials.from_json_keyfile_name(KEY_PATH, scope)
    client = gspread.authorize(creds)
    sh = client.open_by_key(SHEET_ID)

    for i in range(1, 16):
        tab_name = str(i)
        try:
            result = analyze_tab(sh, tab_name)
        except gspread.exceptions.WorksheetNotFound:
            continue
        if not result:
            continue
        if not result["name"] or result["name"].isdigit() or result["name"].endswith("번"):
            # 빈 시트/미가입 멤버는 건너뜀 (이름이 "2번" 같은 기본값인 경우)
            pass

        print(f"=== [{result['tab']}] {result['name']} ({result['goal_type']}) ===")
        for d in result["days"]:
            mark = "확정" if d["confirmed"] else "진행중"
            print(f"  {d['day']} [{mark}] 총 ₩{d['total']:,} — {d['explain']}")
        print(f"  → 이번 주 확정 벌금 합계: ₩{result['week_total_confirmed']:,}")
        print()


if __name__ == "__main__":
    main()
