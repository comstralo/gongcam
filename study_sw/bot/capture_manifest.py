import json
import os
import threading
import time
import uuid

MANIFEST_PATH = "runtime/captures/manifest.json"
ARCHIVE_DIR = "runtime/captures/archive"
ARCHIVE_MANIFEST_PATH = os.path.join(ARCHIVE_DIR, "manifest.json")
ARCHIVE_FILES_DIR = os.path.join(ARCHIVE_DIR, "report")
_manifest_lock = threading.Lock()


def _load(path=MANIFEST_PATH):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
            return json.loads(content) if content.strip() else {}
    except Exception:
        return {}


# 🔧 [버그 수정] 원래는 MANIFEST_PATH에 직접 write했다 — json.dump 도중
# 프로세스가 죽으면(크래시/OOM/강제종료) 파일이 잘린 채로 남고, _load()는
# 파싱 실패 시 조용히 {}를 반환해 전체 캡처/심사 이력이 아무 에러 없이
# 사라졌다. 같은 디렉터리에 임시파일로 먼저 쓰고 os.replace로 원자적
# 교체하면, 쓰기 도중 죽어도 원본 manifest는 그대로 남는다(os.replace는
# 같은 파일시스템 내에서 원자적 연산이다).
def _save(data, path=MANIFEST_PATH):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


# self_check: "내 화각 점검" 여부(사용자 요청) — 대상자가 항상 본인이고
# 벌점/페널티 판정 대상이 아닌 셀프 확인용 캡처다. 웹(index.js)이 entry에
# 실어 보낸 selfCheck 플래그를 그대로 저장해, GET /captures 응답에도
# 실려 나가게 한다(관리자 목록 필터링·본인 조회 라우트 둘 다 이 필드로 구분).
def record_capture(report_id, nickname, reason, mode, filename, reporter_email, self_check=False):
    entry_id = report_id or str(uuid.uuid4())
    with _manifest_lock:
        data = _load()
        data[entry_id] = {
            "id": entry_id,
            "nickname": nickname,
            "reason": reason,
            "mode": mode,
            "filename": os.path.basename(filename),
            "reporterEmail": reporter_email,
            "ts": int(time.time() * 1000),
            "reviewStatus": "pending",
            "selfCheck": bool(self_check),
        }
        _save(data)
    return entry_id


def list_captures(status=None):
    with _manifest_lock:
        data = _load()
    items = list(data.values())
    if status:
        items = [i for i in items if i.get("reviewStatus") == status]
    items.sort(key=lambda i: i.get("ts", 0), reverse=True)
    return items


def get_capture(capture_id):
    with _manifest_lock:
        data = _load()
        item = data.get(capture_id)
        if item is not None:
            return item
        # 🔧 [버그 방어] archive_old_captures로 원본 manifest에서 옮겨진
        # 건도 "예치금 재납 대상자" 카드 등에서 [cap:캡처ID] 이력을 눌러
        # 원본 스크린샷/영상을 다시 불러오는 기존 기능이 계속 동작해야
        # 한다 — 3주 지난 캡처를 archive로 옮긴 것이 "더 이상 조회 불가"를
        # 의미하지는 않는다(사용자 결정: 삭제가 아니라 이동).
        archive_data = _load(ARCHIVE_MANIFEST_PATH)
    return archive_data.get(capture_id)


# penalty/merit: 이 결정으로 시트에 실제 반영된 값(있으면) — 각각
# {number, col, ...} 형태(index.js의 OutputPenaltyResult/ReportMeritResult와
# 동일 구조). manifest 자체에 저장해 두어야, 관리자가 새로고침한 뒤에도
# "반려 취소"/"삭제"가 어느 슬롯을 되돌려야 하는지 알 수 있다(프론트 로컬
# state는 새로고침하면 사라지므로 이 기록에 의존할 수 없다).
def set_decision(capture_id, decision, penalty=None, merit=None):
    with _manifest_lock:
        data = _load()
        if capture_id not in data:
            return False
        data[capture_id]["reviewStatus"] = decision
        data[capture_id]["decidedAt"] = int(time.time() * 1000)
        data[capture_id]["penalty"] = penalty
        data[capture_id]["merit"] = merit
        _save(data)
    return True


# "반려 취소" — 이미 내린 결정(approved/rejected/rejected_recognized)을 되돌려
# 다시 관리자가 판단할 수 있는 "처리 대기" 상태로 되돌린다. decidedAt도 함께
# 지워야 RECENT_DECISION_WINDOW_MS 창이 끝난 뒤 이 항목이 다시 사라지지 않는다.
# penalty/merit 기록도 함께 지운다 — 시트 반영분은 호출자(웹 index.js)가
# 이 함수를 부르기 전에 이미 cancelOutputPenalty/cancelReportMerit로
# 되돌렸다는 전제다.
# 🔧 [버그 수정] targetResponse(대상자의 위반인정/이의제기)는 절대 지우지
# 않는다(사용자 지시: "사용자가 이의제기나 위반인정을 하면 다시 응답
# 대기로 돌아가는 일은 없어야 한다"). 한때는 재검토 시 대상자가 다시
# 응답을 제출할 수 있어야 한다는 이유로 이 필드를 함께 초기화했었으나,
# set_target_response는 이미 응답이 있으면 애초에 재제출 자체를 거부하므로
# (대상자 응답과 관리자 결정은 독립된 절차 — 관리자는 이미 낸 의견을
# 참고해 직접 재판단하면 되고, 대상자가 새로 응답할 필요가 없다) 그
# 초기화는 불필요했을 뿐 아니라, 대상자가 이미 응답한 건도 화면상
# "응답 대기 중"으로 되돌려 보여주는 부작용을 냈다. reviewStatus/결정
# 관련 필드만 되돌리고 대상자 응답 기록은 항상 보존한다.
# 🔧 [버그 수정] 원래는 원본 manifest만 확인했다 — archive_old_captures로
# 이미 옮겨진(3주 이상 지난 확정) 캡처에 대해 관리자가 뒤늦게 "반려 취소"를
# 누르면 capture_id가 원본 manifest에 없어 조용히 False(404)만 반환하고
# 아무 것도 되돌리지 못했다. get_capture()는 이미 archive도 함께 조회하도록
# 되어 있는데 이 함수는 빠져 있었다 — 원본에 없으면 archive manifest에서
# 찾아 그 안에서 되돌린다(파일 자체는 옮길 필요 없음, "반려 취소"는 상태
# 필드만 바꾸는 작업이므로).
def revert_decision(capture_id):
    with _manifest_lock:
        data = _load()
        target_path = MANIFEST_PATH
        if capture_id not in data:
            data = _load(ARCHIVE_MANIFEST_PATH)
            target_path = ARCHIVE_MANIFEST_PATH
            if capture_id not in data:
                return False
        data[capture_id]["reviewStatus"] = "pending"
        data[capture_id].pop("decidedAt", None)
        data[capture_id].pop("penalty", None)
        data[capture_id].pop("merit", None)
        _save(data, target_path)
    return True


# 제보 대상자 본인이 [내 송출 P 제보 확인]에서 "위반인정"/"이의제기" 중
#하나를 누른 결과. reviewStatus(관리자의 최종 결정)와는 별개 필드로 둔다 —
# 당사자 응답과 관리자 결정은 서로 다른 시점·다른 사람이 만드는 독립적인
# 상태라, 하나로 합치면 "이미 인정했는데 관리자가 다시 판단 대기로 되돌리는"
# 경우 등에서 값이 서로를 덮어써 버린다(사용자 지시로 설계된 별도 프로세스:
# 통보 → 당사자 응답 → 관리자 최종 처리).
def set_target_response(capture_id, response, auto=False):
    # 🔧 [버그 수정] 원래는 기존 targetResponse를 확인하지 않고 무조건
    # 덮어썼다 — 대상자가 다중 탭에서 "위반인정"/"이의제기"를 거의 동시에
    # 각각 제출하거나, 90분 자동확정 직후 그 이전에 읽은 스냅샷을 근거로
    # 수동 응답이 뒤늦게 도착하면 "나중에 쓴 값이 이긴다"는 레이스가
    # 생겼다(Worker의 handleCaptureTargetRespond가 처리 전 읽은 스냅샷만
    # 검사하는 TOCTOU 구조라 서버측 409 검증만으로는 못 막음). 이미 응답이
    # 기록된 상태면 거부해 "가장 먼저 도착한 응답이 최종"이 되도록 이 함수
    # 자체에서 원자적으로 막는다 — _manifest_lock이 파일 I/O를 직렬화하는
    # 지점을 그대로 이용해 조건부 쓰기(CAS)처럼 동작하게 한다.
    with _manifest_lock:
        data = _load()
        if capture_id not in data:
            return False
        if data[capture_id].get("targetResponse"):
            return False
        data[capture_id]["targetResponse"] = response
        data[capture_id]["targetRespondedAt"] = int(time.time() * 1000)
        # 90분 타임아웃으로 자동 위반인정된 건인지 - 대상자가 직접 버튼을
        # 눌러 응답한 것과 프론트에서 다른 문구로 구분해 보여주기 위함.
        data[capture_id]["targetResponseAuto"] = bool(auto)
        _save(data)
    return True


# 🔧 [버그 수정] 원래는 원본 manifest만 확인했고, 이미지도 항상
# runtime/captures/report/에서만 지우려 했다 — archive_old_captures로
# 옮겨진 캡처를 관리자가 뒤늦게 "폐기"하면 capture_id가 원본에 없어
# 조용히 실패했고, 설령 manifest 쪽만 archive를 봤더라도 실제 이미지
# 파일은 ARCHIVE_FILES_DIR로 함께 옮겨져 있어 원래 경로에서는 못 찾았을
# 것이다. 원본에 없으면 archive manifest/파일 위치를 폴백으로 사용한다.
def delete_capture(capture_id):
    with _manifest_lock:
        data = _load()
        target_path = MANIFEST_PATH
        files_dir = "runtime/captures/report"
        entry = data.get(capture_id)
        if entry is None:
            data = _load(ARCHIVE_MANIFEST_PATH)
            target_path = ARCHIVE_MANIFEST_PATH
            files_dir = ARCHIVE_FILES_DIR
            entry = data.get(capture_id)
            if entry is None:
                return False
        del data[capture_id]
        _save(data, target_path)
    filename = entry.get("filename")
    if filename:
        path = os.path.join(files_dir, filename)
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    return True


# 매주 월요일 정기 작업(scheduling.py)이 호출한다. cutoff_ms(그 시각보다
# 이전에 접수된 건)에 해당하는 캡처를 완전히 지우지 않고, 원본 manifest에서
# archive/manifest.json으로 옮기고 이미지·영상 파일도 archive/report/로
# 함께 이동한다(사용자 결정: "삭제가 아니라 다른 폴더로 이동") — 관리자
# 목록/자동 위반인정 계산 대상인 원본 manifest는 항상 최근 것만 남아 가벼운
# 채로 유지되고, 지난 기록은 archive만 뒤지면 그대로 남아 있다.
# 🔧 [버그 수정] 원래는 "접수 후 21일 지났는지"를 로컬에서 독립적으로
# 계산했다 — 실제 3주 사이클 길이가 정확히 21일이 아니거나, 새 사이클이
# 막 시작된 직후엔 "이번 사이클 안에서 아직 조회돼야 할" 캡처가 지난
# 사이클 자료와 섞여 먼저 옮겨질 위험이 있었다(사용자 지적). cutoff_ms는
# 이제 호출자(scheduling.py)가 Worker의 /internal/cycle-boundary로 물어본
# "이번 3주 사이클이 시작된 실제 월요일 00:00(KST)"을 그대로 넘겨받는다 —
# 그 이전에 접수된 건은 확실히 지난 사이클 소속이므로만 옮긴다. 반환값은
# 옮긴 건수(로그용).
def archive_old_captures(cutoff_ms):
    with _manifest_lock:
        data = _load()
        archive_data = _load(ARCHIVE_MANIFEST_PATH)
        # 🔧 [버그 수정] 이 함수는 "archive에 먼저 저장 → 그다음 원본에서
        # 삭제 저장" 순서로 쓴다(유실보다 중복이 안전하다는 원칙 — 순서를
        # 반대로 하면 중간에 죽었을 때 "원본에서도 지워졌고 archive에도
        # 아직 없는" 진짜 데이터 유실이 생긴다). 다만 이 순서 자체도
        # 완전히 원자적이지는 않아서, 정확히 두 _save 사이(archive 저장
        # 직후, 원본 저장 직전)에 프로세스가 죽으면 같은 capture_id가
        # archive와 원본 양쪽에 동시에 남는다 — get_capture는 원본을
        # 우선하므로 조회 자체는 안전하지만, 그 중복 상태가 다음 실행까지
        # 방치됐다. 이번 실행 시작 시점에 이미 archive에도 있는 항목이
        # 원본에 남아있으면(=지난 실행이 중간에 죽어 못 끝낸 정리) 여기서
        # 바로 원본에서 마저 지워, 중복이 한 사이클 이상 오래 남지 않게
        # 한다.
        already_archived_but_stale = [cid for cid in data if cid in archive_data]
        for cid in already_archived_but_stale:
            del data[cid]
        # 아직 관리자가 처리하지 않은("pending") 건은 사이클이 넘어가도
        # 아카이빙 대상에서 제외한다 — 지난 사이클로 넘어가도록 미처리로
        # 방치된 제보라면 그 자체가 운영상 챙겨야 할 이례적 상황이지,
        # 관리자 목록에서 조용히 사라져야 할 이유가 되지 않는다.
        to_move = {
            cid: entry
            for cid, entry in data.items()
            if entry.get("ts", cutoff_ms) < cutoff_ms and entry.get("reviewStatus") != "pending"
        }
        if not to_move and not already_archived_but_stale:
            return 0
        for cid, entry in to_move.items():
            archive_data[cid] = entry
            del data[cid]
        _save(archive_data, ARCHIVE_MANIFEST_PATH)
        _save(data)
    os.makedirs(ARCHIVE_FILES_DIR, exist_ok=True)
    for entry in to_move.values():
        filename = entry.get("filename")
        if not filename:
            continue
        src = os.path.join("runtime/captures/report", filename)
        dst = os.path.join(ARCHIVE_FILES_DIR, filename)
        try:
            if os.path.exists(src):
                os.replace(src, dst)
        except OSError:
            pass
    return len(to_move)
