import json
import os
import threading


def save_task_to_disk(ctx, task_info):
    """중단된 작업 정보를 파일에 저장"""
    with ctx.file_lock:
        data = []
        if os.path.exists(ctx.STATE_FILE):
            try:
                with open(ctx.STATE_FILE, "r", encoding="utf-8") as f:
                    content = f.read()
                    if content.strip():
                        data = json.loads(content)
            except:
                pass

        data.append(task_info)

        with open(ctx.STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=4)


def load_tasks_from_disk(ctx):
    """저장된 작업 정보를 불러오고 파일 초기화"""
    with ctx.file_lock:
        if not os.path.exists(ctx.STATE_FILE):
            return []
        try:
            with open(ctx.STATE_FILE, "r", encoding="utf-8") as f:
                content = f.read()
                if not content.strip():
                    return []
                data = json.loads(content)

            # 읽었으면 초기화
            with open(ctx.STATE_FILE, "w", encoding="utf-8") as f:
                f.write("")
            return data
        except:
            return []


def set_thread(ctx, thread_id, target_func, args, kwargs=None):
    # 🔧 [ctx 리팩터] target_func는 모두 ctx를 첫 번째 인자로 받도록 통일했으므로,
    # 호출부에서 넘긴 args 튜플 앞에 ctx를 자동으로 붙여준다.
    # 🔧 kwargs는 선택적으로만 쓴다 — report_id처럼 여러 호출부가 서로 다른
    # 위치 인자 개수로 같은 함수를 호출할 때, 위치 인자 순서가 어긋나는 걸
    # 막기 위한 용도(report_intake.py / scheduling.py 재개 경로 참고).
    with ctx.lock:
        if thread_id not in ctx.current_threads:
            new_thread = threading.Thread(
                target=target_func,
                args=(ctx,) + tuple(args),
                kwargs=kwargs or {},
                daemon=True,
            )
            ctx.current_threads[thread_id] = new_thread
            new_thread.start()

            print(f"set_thread() :  ⚙️  {thread_id} 생성 및 시작.  ⚙️")

            return True
        else:
            print(
                f"set_thread() :  ⚙️ {thread_id} 생성 실패. (current_threads에 이미 존재)  ⚙️"
            )
            return False


# [ETC] 작업이 완료된 스레드는 목록에서 삭제
def remove_thread_id(ctx, thread_id):
    with ctx.lock:
        if thread_id in ctx.current_threads:
            del ctx.current_threads[thread_id]
            print(f"remove_thread_id() :  ⚙️  {thread_id} 완료 및 종료.  ⚙️")

            return True
        else:
            print(
                f"remove_thread_id() :  ⚙️ {thread_id} 삭제 실패. (current_threads에 없음)  ⚙️"
            )
            return False


# [ETC] 모든 스레드 안전 종료
def stop_all_thread(ctx):
    print("stop_all_thread() :  ⚙️  모든 스레드 종료 시작.  ⚙️")

    # 1. 종료할 스레드 목록을 lock을 잡고 안전하게 복사
    with ctx.lock:
        threads_to_stop = list(ctx.current_threads.items())
        if not threads_to_stop:
            print("stop_all_thread() :  ⚙️  종료할 실행 중인 스레드가 없습니다.  ⚙️")
            return

    # 2. 모든 스레드에 종료 신호 전송 (단, set_sheet 내부에는 감지 로직이 없어 끝까지 실행됨)
    ctx.stop_event.set()
    print(
        f"stop_all_thread() :  ⚙️  {len(threads_to_stop)}개의 스레드에 종료 신호를 보냈습니다.  ⚙️"
    )

    # 3. Lock을 해제한 상태에서 각 스레드가 종료될 때까지 대기
    for thread_id, thread in threads_to_stop:
        # 💡 개선 포인트: 시트 기록 스레드는 작업 완료가 보장되어야 하므로 join()으로 대기하지 않고 넘김
        if "시트" in thread_id or "기록" in thread_id:
            print(
                f"stop_all_thread() : 🛡️ 시트 기록 스레드 [{thread_id}]는 백그라운드에서 작업 완료를 보장합니다."
            )
            continue

        # thread.join()은 스레드가 완전히 종료될 때까지 기다리는 함수입니다.
        # 🚨 [핵심 수정] 무한 대기 방지: 3초까지만 기다려보고 안 꺼지면 뻗은 것으로 간주하고 버림
        thread.join(timeout=11.0)
        if thread.is_alive():
            print(
                f"stop_all_thread() : ⚠️ 스레드 [{thread_id}] 응답 없음! 강제로 스킵합니다."
            )
        else:
            print(f"stop_all_thread() :  ⚙️  스레드 [{thread_id}] 종료 대기 완료.  ⚙️")

    # 4. 종료가 완료된 스레드만 딕셔너리에서 정리하고 이벤트 초기화
    with ctx.lock:
        for thread_id, thread in threads_to_stop:
            # 강제로 기다리지 않은 시트 기록 스레드는 여기서 지우지 않고 스스로 지우도록 둡니다.
            if "시트" not in thread_id and "기록" not in thread_id:
                if thread_id in ctx.current_threads:
                    del ctx.current_threads[thread_id]
        # stop_event.clear()  # 다음 스케줄을 위해 이벤트 초기화

    print("stop_all_thread() :  ⚙️  모든 스레드 종료 정리 완료.  ⚙️")


# 🔥 추가: 메인 스레드 블로킹을 막기 위해 스케줄 작업을 별도 스레드로 던져주는 도우미 함수
def run_threaded_schedule(ctx, *args, **kwargs):
    # 🔧 순환 임포트 방지: bot.scheduling이 bot.threads(load_tasks_from_disk,
    # set_thread 등)를 임포트하므로, schedule_process는 호출 시점에만 지역 임포트한다.
    from bot.scheduling import schedule_process

    thread = threading.Thread(target=schedule_process, args=(ctx,) + args, kwargs=kwargs)
    thread.start()
