from IoT_backend.models.db import get_db

def find_user_by_uid(uid):
    db = get_db()
    cursor = db.cursor(dictionary=True)

    cursor.execute(
        "SELECT * FROM users WHERE rfid_uid = %s AND active = TRUE",
        (uid,)
    )
    user = cursor.fetchone()

    cursor.close()
    db.close()

    return user


def log_access(user_id, status):
    db = get_db()
    cursor = db.cursor()

    cursor.execute(
        "INSERT INTO access_logs (user_id, status) VALUES (%s, %s)",
        (user_id, status)
    )
    db.commit()

    cursor.close()
    db.close()