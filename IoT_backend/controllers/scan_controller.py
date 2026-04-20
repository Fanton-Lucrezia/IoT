from IoT_backend.models.user_model import (find_user_by_uid, log_access)

def handle_scan(uid):
    user = find_user_by_uid(uid)

    if user:
        log_access(user["id"], "OK")
        return {"success": True, "user": user["name"]}
    else:
        return {"success": False}