import glob
import json
import os
import re
import threading

# 🔧 [버그 방어] tracking_capture()의 중단 처리(save_task_to_disk 호출부,
# tracking.py)는 stop_event로 "정상적으로" 중단될 때만 실행된다 — 프로세스
# 자체가 즉사하면(OOM killer, kill -9, 정전 등 atexit/signal 핸들러조차
# 못 타는 경우) 그 코드 자체가 실행될 기회가 없어, 그때까지 메모리에만
# 있던 진행 상황(찍은 스크린샷들, 남은 목표 횟수)이 통째로 사라진다(사용자
# 확인: 발견한 이상 대비할 것). 이를 막기 위해 캡처를 한 장 찍을 때마다
# (정상 종료 여부와 무관하게) 진행 상황 스냅샷을 이 디렉터리에 즉시
# 원자적으로 덮어써 둔다 — 정상 종료/정상 중단 시에는 clear_inflight_snapshot
# 으로 지우므로, 다음 프로그램 시작 시 여기 파일이 남아있다는 것 자체가
# "즉사로 중단된 작업이 있다"는 신호가 된다. recover_inflight_snapshots가
# 그 파일들을 기존 STATE_FILE 재개 큐로 그대로 합류시켜, 기존 재개 로직
# (load_tasks_from_disk → tracking_capture(previous_temp_files=...))을
# 그대로 재사용한다 — 재개 경로를 새로 만들 필요가 없다.
INFLIGHT_DIR = "runtime/captures/inflight"


def _inflight_path(thread_id):
    safe_name = re.sub(r"[^0-9A-Za-z가-힣_-]", "_", thread_id)
    return os.path.join(INFLIGHT_DIR, f"{safe_name}.json")


def save_inflight_snapshot(ctx, thread_id, resume_info):
    os.makedirs(INFLIGHT_DIR, exist_ok=True)
    path = _inflight_path(thread_id)
    tmp_path = f"{path}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(resume_info, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    except OSError as e:
        ctx.logger.warning(f"save_inflight_snapshot() : ⚠️ 스냅샷 저장 실패 - {e}")


def clear_inflight_snapshot(ctx, thread_id):
    path = _inflight_path(thread_id)
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


# 프로그램 시작 시 딱 한 번 호출한다(study_manager_260418.py). 남아있는
# inflight 스냅샷은 지난 실행이 즉사로 끝났다는 뜻이므로, 기존 재개 큐
# (STATE_FILE)에 그대로 합류시켜 다음 첫 스케줄(schedule_process)이 평소
# 재개 경로로 자연스럽게 이어받게 한다. 이 함수 자체가 실행되는 시점(즉
# 프로그램이 정상적으로 재기동된 시점)엔 더 이상 즉사 위험이 없으므로,
# 합류 후 inflight 폴더는 비워 다음 캡처들이 다시 채우게 한다.
def recover_inflight_snapshots(ctx):
    if not os.path.isdir(INFLIGHT_DIR):
        return
    paths = glob.glob(os.path.join(INFLIGHT_DIR, "*.json"))
    if not paths:
        return
    recovered = 0
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            if content.strip():
                resume_info = json.loads(content)
                save_task_to_disk(ctx, resume_info)
                recovered += 1
        except Exception as e:
            print(f"recover_inflight_snapshots() : ⚠️ 스냅샷 복구 실패({path}) - {e}")
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
    if recovered:
        print(f"recover_inflight_snapshots() : 💾 즉사로 중단됐던 캡처 {recovered}건을 재개 대기열에 합류시켰습니다.")


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
