import json
import os
import threading
import time
import uuid

MANIFEST_PATH = "runtime/leave_proof/manifest.json"
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


# 🔧 [버그 수정] 원래는 MANIFEST_PATH에 직접 write했다 — json.dump 도중
# 프로세스가 죽으면(크래시/OOM/강제종료) 파일이 잘린 채로 남고, _load()는
# 파싱 실패 시 조용히 {}를 반환해 전체 사유반휴 신청 이력이 아무 에러 없이
# 사라졌다. capture_manifest.py에 이미 적용된 것과 동일하게, 같은
# 디렉터리에 임시파일로 먼저 쓰고 os.replace로 원자적 교체하면 쓰기 도중
# 죽어도 원본 manifest는 그대로 남는다.
def _save(data):
    os.makedirs(os.path.dirname(MANIFEST_PATH), exist_ok=True)
    tmp_path = f"{MANIFEST_PATH}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, MANIFEST_PATH)


def record_request(member_number, member_name, day, reason, filename, requester_email, count=1, entry_id=None):
    """사유반휴 신청 1건을 등록한다. filename은 이미 디스크에 저장된 이름
    (호출부가 base64를 디코드해 먼저 저장한 뒤 넘김). count는 같은 증빙으로
    한 번에 처리할 장수(1 또는 2) — 승인 시 그만큼 시트에 반영된다.
    entry_id를 지정하면(Worker의 KV 큐 항목을 그대로 흘려보내는 경우) 그
    id를 그대로 쓴다 — 관리자가 큐 id 기준으로 이미 승인/반려를 처리한
    뒤 뒤늦게 같은 항목이 봇에 도달해도 별개의 유령 pending 레코드가
    생기지 않고, 이미 있으면 갱신 없이 기존 항목을 그대로 둔다."""
    with _manifest_lock:
        data = _load()
        if entry_id and entry_id in data:
            return entry_id
        entry_id = entry_id or str(uuid.uuid4())
        data[entry_id] = {
            "id": entry_id,
            "memberNumber": member_number,
            "memberName": member_name,
            "day": day,
            "reason": reason,
            "filename": os.path.basename(filename),
            "requesterEmail": requester_email,
            "count": count,
            "ts": int(time.time() * 1000),
            "reviewStatus": "pending",  # pending | approved | rejected
            "rejectReason": None,
        }
        _save(data)
    return entry_id


def list_requests(status=None, member_number=None):
    with _manifest_lock:
        data = _load()
    items = list(data.values())
    if status:
        items = [i for i in items if i.get("reviewStatus") == status]
    if member_number:
        items = [i for i in items if i.get("memberNumber") == member_number]
    items.sort(key=lambda i: i.get("ts", 0), reverse=True)
    return items


def get_request(request_id):
    with _manifest_lock:
        data = _load()
    return data.get(request_id)


def set_decision(request_id, decision, reject_reason=None):
    with _manifest_lock:
        data = _load()
        if request_id not in data:
            return False
        data[request_id]["reviewStatus"] = decision
        data[request_id]["decidedAt"] = int(time.time() * 1000)
        if decision == "rejected":
            data[request_id]["rejectReason"] = reject_reason or ""
        _save(data)
    return True
