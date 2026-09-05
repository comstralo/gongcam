import threading
import time
from datetime import datetime

import pandas as pd
import schedule

from bot.gooroomee_room import daily_browser_reset, enter_studyroom, layout_manager
from bot.sheets import set_sheet
from bot.threads import (
    load_tasks_from_disk,
    run_threaded_schedule,
    set_thread,
    stop_all_thread,
)
from bot.tracking import tracking_capture


# [MAIN] 함수 스케줄링 등록
def schedule_reserve(ctx):

    ctx.timetable_df = pd.read_csv("./assets/timetable.csv", encoding="utf-8")

    for _, row in ctx.timetable_df.iterrows():
        period_start_time = row["시작시간"]
        period_end_time = row["종료시간"]
        period_str = row["교시"]
        period_minute = row["분"]

        # 교시 시작 시간에 함수 호출 예약
        schedule.every().day.at(period_start_time).do(
            run_threaded_schedule,  # 🔥 수정: schedule_process 동기 호출 대신 스레드 래퍼 함수 호출
            ctx,
            period_str=period_str,
            period_time=period_start_time,
            period_minute=period_minute,
            schedule_kind="period_start",
        )
        print(
            f"schedule_reserve() :  ⏰  [{period_str}] [{period_start_time}] 시작 스케줄링 등록.  ⏰"
        )

        # 교시 종료 시간에 함수 호출 예약
        schedule.every().day.at(period_end_time).do(
            run_threaded_schedule,  # 🔥 수정: schedule_process 동기 호출 대신 스레드 래퍼 함수 호출
            ctx,
            period_str=period_str,
            period_time=period_end_time,
            period_minute=period_minute,
            schedule_kind="period_end",
        )
        print(
            f"schedule_reserve() :  ⏰  [{period_str}] [{period_end_time}] 종료 스케줄링 등록.  ⏰"
        )

    # 07:15 정기 리셋은 브라우저 자체를 껐다 켜는 핵심 작업이므로 기존처럼 동기식으로 둡니다.
    schedule.every().day.at("07:15").do(daily_browser_reset, ctx)
    print(
        "schedule_reserve() :  ⏰  [정기 리셋] [07:15] 브라우저 초기화 스케줄링 등록.  ⏰"
    )


# [MAIN] 예약 스케줄 감지 및 실행
def run_scheduler(ctx):

    # 프로그램 처음 실행되면 스케줄 등록
    schedule_reserve(ctx)

    while True:
        # 스케줄된 작업을 계속 확인하고 실행
        print(
            f"run_scheduler() : 🖥️  현재 실행 중인 스레드는 {threading.active_count()}개.  🖥️",
            end="\r",
        )
        # 🚨 [수정] 브라우저가 비상 복구 중일 때는 스케줄 실행을 잠시 보류합니다.
        if not ctx.is_browser_resetting:
            schedule.run_pending()

        time.sleep(0.5)


# [MAIN] 함수 스케줄링 처리
# [MAIN] 교시 스케줄링 처리
def schedule_process(ctx, period_str, period_time, period_minute, schedule_kind):
    # 1. 스케줄 유효성 검사 (Time-to-Live 방어 로직)
    now = datetime.now()
    now_minutes = now.hour * 60 + now.minute

    target_h, target_m = map(int, period_time.split(":"))
    target_minutes = target_h * 60 + target_m

    # 시간 차이 계산 (자정이 넘어간 경우 보정)
    diff = now_minutes - target_minutes
    if diff < 0:
        diff += 24 * 60

    # 타겟 시간보다 10분 이상 지연된 스케줄이라면 무시하고 종료!
    if diff > 10:
        ctx.logger.warning(
            f"⚠️ [방어 시스템] 지연된 스케줄 폭주 차단: {period_str} ({schedule_kind}) / 예정: {period_time}, 현재: {now.strftime('%H:%M')}"
        )
        return

    if ctx.is_browser_resetting:
        ctx.logger.warning(f"⚠️ 브라우저 복구 중이므로 [{period_str}] 스케줄을 건너뜁니다.")
        return

    ctx.logger.info(
        f"schedule_process() :  ⏰   [{period_str}] [{period_time}] [{'{시작}' if schedule_kind == 'period_start' else '{종료}'}] 스케줄링 시작.  ⏰ "
    )

    # 모든 실행중인 스레드 종료
    stop_all_thread(ctx)

    # 🚨 [추가] 정상 스케줄 프로세스에서도 스레드 정리 후 이벤트를 초기화합니다.
    ctx.stop_event.clear()

    # 🔥 [핵심 추가] 교시 시작 시점에만 메모리 확보를 위해 강제 새로고침(Refresh) 지시
    is_start_period = schedule_kind == "period_start"

    # 스터디룸 접속이 완료된 경우에만 (강제 새로고침 플래그 전달)
    if enter_studyroom(ctx, force_reload=is_start_period):
        ctx.logger.info(
            f"schedule_process() : ✅   스터디룸 접속(또는 새로고침) 완료.  ✅ "
        )

        # 14교시 종료면 스케줄 재등록
        if period_str == "14교시" and schedule_kind == "period_end":
            ctx.logger.info(f"schedule_process() :  ⏰   교시 스케줄링 재등록 초기화.  ⏰ ")
            schedule.clear()
            schedule_reserve(ctx)

        # 교시 시작, 종료 시간에만
        if schedule_kind == "period_start" or schedule_kind == "period_end":

            # 💡 수정된 부분: 스터디로그 기록 스레드 ID에 교시와 시작/종료 여부를 명시하여 중복 실행 충돌 방지
            thread_id = (
                f"[시트기록 : 구루미 스터디로그] / [{period_str}_{schedule_kind}]"
            )
            set_thread(
                ctx,
                thread_id,
                set_sheet,
                (
                    [
                        "write_studylog",
                        [
                            period_str,
                            schedule_kind,
                            period_minute,
                            thread_id,
                        ],
                    ],
                ),
            )

        # 항상 실행되는 스레드
        # set_thread(ctx, "[레이아웃 관리]", layout_manager, ())  # 레이아웃 자동 변경 비활성화
        # 구루미 채팅 송수신은 서비스(관리자 페이지)로 대체되어 완전히 제거됨

        # ▼ [추가된 코드] 중단된 작업 불러와서 재개하기 ---------------------------
        saved_tasks = load_tasks_from_disk(ctx)

        if saved_tasks:
            ctx.logger.info(
                f"schedule_process() : 💾 중단된 작업 {len(saved_tasks)}개를 재개합니다."
            )

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
                        task["remaining_count"],  # 여기서는 전체 목표 갯수가 들어감
                        task["interval"],
                        task.get("previous_temp_files", []),  # 임시 파일 경로 전달
                    ),
                    kwargs={"report_id": task.get("report_id")},
                )
        # ▲ -------------------------------------------------------------------

