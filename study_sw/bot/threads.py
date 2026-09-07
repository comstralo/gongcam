import glob
import hashlib
import json
import os
import re
import threading
import time

# 좀비 스레드(stop_event에 반응하지 않고 join(timeout=11.0) 이후에도
# 살아있는 스레드)를 stop_all_thread가 처음 발견한 시점부터 이 시간이
# 지나도 여전히 좀비 상태면 강제로 current_threads에서 지운다(사용자
# 결정) — 좀비를 무기한 보존하면 해당 대상자에 대한 이후 모든 제보가
# 프로세스 재시작 전까지 영구히 캡처를 시작 못 하는 문제가 생기므로,
# "데이터 손상 위험"과 "영구 봉쇄" 사이에서 일정 시간 뒤에는 새 스레드가
# 다시 시작될 수 있게 완화한다. 정기 리셋(07:15)/교시 전환(최대 하루
# 28회)마다 stop_all_thread가 불리므로, 5분이면 짧게는 다음 교시 전환
# 시점에, 늦어도 몇 차례 안에 강제 정리가 이뤄진다.
ZOMBIE_FORCE_CLEAR_SEC = 5 * 60

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


# 🔧 [버그 수정] 원래는 정규식 치환만으로 안전한 파일명을 만들었다 —
# 특수문자를 전부 "_"로 뭉개는 방식이라, 예를 들어 닉네임 "철수!"와
# "철수@"가 서로 다른 대상자인데도 같은 sanitize 결과("철수_")로 충돌했다.
# 두 스레드가 같은 파일을 공유하게 되면, 한쪽이 먼저 정상 완료돼
# clear_inflight_snapshot을 호출하는 순간 아직 진행 중인 다른 쪽의 스냅샷
# 파일까지 함께 지워져, 그 상태에서 즉사하면 그 스레드의 진행 상황을 다시는
# 복구할 수 없었다. 원본 thread_id의 해시를 파일명에 덧붙여, sanitize
# 결과가 같아도 서로 다른 파일을 가리키게 한다(가독성을 위해 sanitize된
# 이름은 그대로 유지하고 구분용 접미사만 추가).
def _inflight_path(thread_id):
    safe_name = re.sub(r"[^0-9A-Za-z가-힣_-]", "_", thread_id)
    digest = hashlib.sha1(thread_id.encode("utf-8")).hexdigest()[:10]
    return os.path.join(INFLIGHT_DIR, f"{safe_name}_{digest}.json")


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
# 🔧 [버그 수정] 원래는 반환값이 없었다 — 호출자(study_manager_260418.py)가
# 그 직후(원래는 직전) "고아 임시 파일 정리"로 runtime/captures/temp/*.png를
# 무조건 전부 지웠는데, 이 함수가 방금 재개 큐로 옮긴 resume_info의
# previous_temp_files가 가리키는 이미지도 하필 그 폴더 안에 있어 즉사 방어가
# 지켜야 할 파일을 그 청소 로직이 지워버렸다. 호출자가 "이 파일들만은 지우지
# 말라"고 판단할 수 있도록, 복구된 각 resume_info의 previous_temp_files를
# 모아 반환한다.
def recover_inflight_snapshots(ctx):
    preserved_paths = set()
    if not os.path.isdir(INFLIGHT_DIR):
        return preserved_paths
    paths = glob.glob(os.path.join(INFLIGHT_DIR, "*.json"))
    if not paths:
        return preserved_paths
    recovered = 0
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            if content.strip():
                resume_info = json.loads(content)
                save_task_to_disk(ctx, resume_info)
                preserved_paths.update(resume_info.get("previous_temp_files") or [])
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
    return preserved_paths


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


# 🔧 [버그 방어] tracking_capture/tracking_capture_video의 메인 루프 조건이
# 원래 "thread_id in ctx.current_threads"였다 — 이는 "이 thread_id로 등록된
# *어떤* 스레드든 살아있으면 계속 돈다"는 뜻이라, 강제로 지워진 좀비 스레드
# 자신도 이 조건을 그대로 검사한다. 좀비가 지워진 직후엔 이 조건이 False가
# 되어 좀비도 다음 루프에서 스스로 멈추는 게 맞지만, 그 사이 같은 대상에
# 대한 새 제보로 같은 thread_id의 새 스레드가 등록되면, 조건이 다시 True가
# 되어 좀비가 계속 살아서 새로 재기동된 ctx.driver/ctx.lock_element를 붙잡고
# 도는 상태가 됐다(그러면 두 스레드가 같은 대상에 대해 동시에 파일을 쓰고
# 텔레그램을 보내는 등 중복 처리가 생긴다). 단순히 "존재하는지"가 아니라
# "지금 이 키에 등록된 게 나 자신인지"를 확인해야 정확하다.
def is_current_thread(ctx, thread_id):
    with ctx.lock:
        return ctx.current_threads.get(thread_id) is threading.current_thread()


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
# 🔧 [버그 수정] 원래는 thread_id 문자열만 보고 지웠다 — ZOMBIE_FORCE_CLEAR_SEC
# (stop_all_thread)가 좀비 스레드를 current_threads에서 강제로 지운 뒤, 같은
# thread_id로 새 캡처 스레드가 정상적으로 등록될 수 있게 됐는데, 그 뒤늦게
# 좀비가 스스로 깨어나(예: 지연됐던 Selenium 호출이 뒤늦게 반환/예외) 자기
# 종료 처리로 remove_thread_id(ctx, thread_id)를 호출하면, 문자열만 같으면
# 조건이 참이 되어 실제로는 좀비가 아니라 그 자리에 새로 등록된 정상
# 스레드의 항목을 지워버렸다. tracking_capture/tracking_capture_video의
# 메인 루프 조건 자체가 "thread_id in ctx.current_threads"라서, 이렇게
# 지워지면 정상 진행 중이던 새 스레드가 다음 루프에서 "나 중단 요청받았네"
# 로 착각해 아무 중단 신호도 없었는데 진행 중이던 캡처를 조용히 끊어버렸다.
# threading.current_thread()로 "지금 이 함수를 부르는 스레드 자신"을 얻어,
# current_threads[thread_id]에 저장된 Thread 객체가 정확히 나 자신일 때만
# 지운다 — 좀비가 뒤늦게 이 함수를 불러도 그 키의 값이 이미 다른(새) Thread
# 객체로 바뀌어 있으면 identity가 다르므로 무해한 no-op이 된다.
def remove_thread_id(ctx, thread_id):
    caller = threading.current_thread()
    with ctx.lock:
        registered = ctx.current_threads.get(thread_id)
        if registered is caller:
            del ctx.current_threads[thread_id]
            print(f"remove_thread_id() :  ⚙️  {thread_id} 완료 및 종료.  ⚙️")
            return True
        elif registered is None:
            print(
                f"remove_thread_id() :  ⚙️ {thread_id} 삭제 실패. (current_threads에 없음)  ⚙️"
            )
            return False
        else:
            # 이 키는 이미 다른(새로 등록된) 스레드 소유다 — 나(좀비)는
            # 조용히 물러난다. 남의 등록 정보를 지우지 않는다.
            print(
                f"remove_thread_id() :  ⚙️ {thread_id} 삭제 건너뜀. (이미 다른 스레드로 교체됨 — 좀비의 뒤늦은 종료로 추정)  ⚙️"
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
    now = time.time()
    with ctx.lock:
        for thread_id, thread in threads_to_stop:
            # 강제로 기다리지 않은 시트 기록 스레드는 여기서 지우지 않고 스스로 지우도록 둡니다.
            if "시트" not in thread_id and "기록" not in thread_id:
                # 🔧 [버그 수정] 원래는 join(timeout=11.0) 이후 thread.is_alive()
                # 여부와 무관하게 무조건 지웠다 — 바로 위 212행에서 "응답
                # 없음"으로 로그를 남기고도 그 판단이 삭제 여부에는 반영되지
                # 않았다. stop_event에 반응하지 않는 좀비 스레드(예: Selenium
                # 호출이 멈춘 경우)가 지워지면, 그 스레드는 여전히 살아서
                # ctx.driver와 대상자를 계속 건드리는 중인데도 current_threads
                # 에는 없는 것으로 보여, 다음 재개/재제보 시점에 set_thread가
                # "비어 있다"고 착각해 같은 대상에 대해 새 스레드를 또
                # 만들었다 — 좀비 스레드와 새 스레드가 동시에 같은 대상을
                # 추적하는 상황이 생겼다. 실제로 죽은 스레드만 지우도록
                # 수정한다 — 좀비는 딕셔너리에 남겨 두어(이 함수 주석의
                # 원래 의도인 "종료가 완료된 스레드만 정리"를 그대로
                # 지킴), 같은 대상에 대한 이후 요청이 조용히 중복 시작되지
                # 않고 "이미 진행 중"으로 정확히 스킵되게 한다.
                if not thread.is_alive():
                    if thread_id in ctx.current_threads:
                        del ctx.current_threads[thread_id]
                    ctx.zombie_since.pop(thread_id, None)
                else:
                    # 🔧 [버그 방어] 좀비를 무기한 보존하면, 그 스레드가
                    # 정말로 영원히 안 죽는 경우(예: Selenium 호출이 응답
                    # 없이 완전히 멈춤) 해당 대상자에 대한 이후 모든 제보가
                    # 프로세스 재시작 전까지 영구히 캡처를 시작 못 하게
                    # 된다(사용자 결정: 일정 시간 지나면 강제로 지운다).
                    # 이번이 처음 좀비로 판정된 순간이면 시각만 기록하고,
                    # 이미 기록돼 있는데 ZOMBIE_FORCE_CLEAR_SEC(5분)가 지나도
                    # 여전히 좀비면 강제로 지워 다음 요청이 새 스레드를 시작할
                    # 수 있게 한다 — 좀비 자체(옛 driver를 계속 참조하며
                    # 도는 스레드)는 프로세스 안에 남아있을 수 있지만, 이는
                    # kill_selenium_processes()가 다음 정기 리셋에서 그
                    # driver의 실제 크롬 프로세스를 정리해 결국 예외로
                    # 끝나도록 유도한다.
                    first_seen = ctx.zombie_since.get(thread_id)
                    if first_seen is None:
                        ctx.zombie_since[thread_id] = now
                    elif now - first_seen >= ZOMBIE_FORCE_CLEAR_SEC:
                        print(
                            f"stop_all_thread() : 🪓 스레드 [{thread_id}]가 {ZOMBIE_FORCE_CLEAR_SEC}초 넘게 응답이 없어 강제로 정리합니다."
                        )
                        if thread_id in ctx.current_threads:
                            del ctx.current_threads[thread_id]
                        ctx.zombie_since.pop(thread_id, None)
        # stop_event.clear()  # 다음 스케줄을 위해 이벤트 초기화

    print("stop_all_thread() :  ⚙️  모든 스레드 종료 정리 완료.  ⚙️")


# 🔥 추가: 메인 스레드 블로킹을 막기 위해 스케줄 작업을 별도 스레드로 던져주는 도우미 함수
def run_threaded_schedule(ctx, *args, **kwargs):
    # 🔧 순환 임포트 방지: bot.scheduling이 bot.threads(load_tasks_from_disk,
    # set_thread 등)를 임포트하므로, schedule_process는 호출 시점에만 지역 임포트한다.
    from bot.scheduling import schedule_process

    thread = threading.Thread(target=schedule_process, args=(ctx,) + args, kwargs=kwargs)
    thread.start()
