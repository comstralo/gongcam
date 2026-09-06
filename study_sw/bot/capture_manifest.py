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


def record_capture(report_id, nickname, reason, mode, filename, reporter_email):
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
