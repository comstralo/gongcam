import json
import os
import threading
import time
import uuid

MANIFEST_PATH = "runtime/captures/manifest.json"
_manifest_lock = threading.Lock()


def _load():
    if not os.path.exists(MANIFEST_PATH):
        return {}
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            content = f.read()
            return json.loads(content) if content.strip() else {}
    except Exception:
        return {}


def _save(data):
    os.makedirs(os.path.dirname(MANIFEST_PATH), exist_ok=True)
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


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
    return data.get(capture_id)


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
def revert_decision(capture_id):
    with _manifest_lock:
        data = _load()
        if capture_id not in data:
            return False
        data[capture_id]["reviewStatus"] = "pending"
        data[capture_id].pop("decidedAt", None)
        data[capture_id].pop("penalty", None)
        data[capture_id].pop("merit", None)
        _save(data)
    return True


# 제보 대상자 본인이 [내 송출 P 제보 확인]에서 "위반인정"/"이의제기" 중
#하나를 누른 결과. reviewStatus(관리자의 최종 결정)와는 별개 필드로 둔다 —
# 당사자 응답과 관리자 결정은 서로 다른 시점·다른 사람이 만드는 독립적인
# 상태라, 하나로 합치면 "이미 인정했는데 관리자가 다시 판단 대기로 되돌리는"
# 경우 등에서 값이 서로를 덮어써 버린다(사용자 지시로 설계된 별도 프로세스:
# 통보 → 당사자 응답 → 관리자 최종 처리).
def set_target_response(capture_id, response, auto=False):
    with _manifest_lock:
        data = _load()
        if capture_id not in data:
            return False
        data[capture_id]["targetResponse"] = response
        data[capture_id]["targetRespondedAt"] = int(time.time() * 1000)
        # 90분 타임아웃으로 자동 위반인정된 건인지 - 대상자가 직접 버튼을
        # 눌러 응답한 것과 프론트에서 다른 문구로 구분해 보여주기 위함.
        data[capture_id]["targetResponseAuto"] = bool(auto)
        _save(data)
    return True


def delete_capture(capture_id):
    with _manifest_lock:
        data = _load()
        entry = data.get(capture_id)
        if entry is None:
            return False
        del data[capture_id]
        _save(data)
    filename = entry.get("filename")
    if filename:
        path = os.path.join("runtime/captures/report", filename)
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    return True
