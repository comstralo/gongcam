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


def set_decision(capture_id, decision):
    with _manifest_lock:
        data = _load()
        if capture_id not in data:
            return False
        data[capture_id]["reviewStatus"] = decision
        data[capture_id]["decidedAt"] = int(time.time() * 1000)
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
