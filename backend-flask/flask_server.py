"""
DOORmotic - Flask Server con MongoDB
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from datetime import datetime
from pymongo import MongoClient, DESCENDING
import hashlib
import os

app = Flask(__name__)
CORS(app)

# ══════════════════════════════════════════════
# CONFIGURAZIONE
# ══════════════════════════════════════════════
SECRET_CODE    = "DOORMOTIC2026"
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "admin"

# ══════════════════════════════════════════════
# CONNESSIONE MONGODB
# ══════════════════════════════════════════════
#MONGO_URL = os.environ.get("MONGO_URL", "mongodb://mongo:CCVLWSOtgsVPCbUPZbUoJIIKnXbBqSYo@mongodb.railway.internal:27017")

MONGO_URL = os.environ.get("MONGO_URL")

print(f"[DB] Connessione a: {MONGO_URL[:40]}...")

client       = MongoClient(MONGO_URL)
db           = client["doormotic"]
users_col    = db["users"]
accesses_col = db["accesses"]

door_state = {"aperta": False}


# ══════════════════════════════════════════════
# UTILITY
# ══════════════════════════════════════════════

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def init_db():
    if users_col.find_one({"username": ADMIN_USERNAME}) is None:
        users_col.insert_one({
            "username":        ADMIN_USERNAME,
            "password":        hash_password(ADMIN_PASSWORD),
            "is_admin":        True,
            "has_door_access": True,
            "rfid_tag":        None
        })
        print("[DB] Utente admin creato")
    else:
        print("[DB] Utente admin già esistente")

def get_username_by_tag(tag_id: str) -> str:
    user = users_col.find_one({"rfid_tag": tag_id})
    return user["username"] if user else "Sconosciuto/Tag"

def add_access_log(username: str, tag_id: str, is_bloccata: bool):
    accesses_col.insert_one({
        "username":    username,
        "tag_id":      tag_id,
        "timestamp":   datetime.now().isoformat(),
        "is_bloccata": is_bloccata
    })


# ══════════════════════════════════════════════
# ENDPOINTS — AUTENTICAZIONE
# ══════════════════════════════════════════════

@app.route("/login", methods=["POST"])
def login():
    data     = request.json or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    user = users_col.find_one({"username": username})

    if not user:
        return jsonify({"success": False, "message": "Utente non trovato"}), 401

    if user["password"] != hash_password(password):
        return jsonify({"success": False, "message": "Password errata"}), 401

    return jsonify({
        "success":         True,
        "username":        username,
        "is_admin":        user["is_admin"],
        "has_door_access": user["has_door_access"],
        "rfid_tag":        user.get("rfid_tag")
    })


@app.route("/register", methods=["POST"])
def register():
    data        = request.json or {}
    username    = data.get("username", "").strip()
    password    = data.get("password", "")
    secret_code = data.get("secret_code", "").strip()

    if not username or not password:
        return jsonify({"success": False, "message": "Compila tutti i campi"}), 400

    if len(password) < 6:
        return jsonify({"success": False, "message": "Password troppo corta (min 6 caratteri)"}), 400

    if users_col.find_one({"username": username}):
        return jsonify({"success": False, "message": "Username già in uso"}), 400

    has_access = (secret_code == SECRET_CODE)

    users_col.insert_one({
        "username":        username,
        "password":        hash_password(password),
        "is_admin":        False,
        "has_door_access": has_access,
        "rfid_tag":        None
    })

    msg = ("Registrazione completata! Hai accesso alla porta."
           if has_access else
           "Registrazione completata. Senza codice valido non puoi aprire la porta.")

    return jsonify({"success": True, "message": msg, "has_door_access": has_access})


# ══════════════════════════════════════════════
# ENDPOINTS — UTENTI (ADMIN)
# ══════════════════════════════════════════════

@app.route("/users", methods=["GET"])
def get_users():
    """Ritorna tutti gli utenti (senza password)."""
    docs = list(users_col.find({}, {"_id": 0, "password": 0}))
    return jsonify(docs)


@app.route("/assign_tag", methods=["POST"])
def assign_tag():
    """Assegna un UID RFID a un utente esistente."""
    data     = request.json or {}
    username = data.get("username", "").strip()
    rfid_tag = data.get("rfid_tag", "").strip()

    if not username or not rfid_tag:
        return jsonify({"success": False, "message": "username e rfid_tag obbligatori"}), 400

    # Controlla che il tag non sia già assegnato a qualcun altro
    existing = users_col.find_one({"rfid_tag": rfid_tag})
    if existing and existing["username"] != username:
        return jsonify({
            "success": False,
            "message": f"Tag già assegnato a {existing['username']}"
        }), 400

    result = users_col.update_one(
        {"username": username},
        {"$set": {"rfid_tag": rfid_tag}}
    )

    if result.matched_count == 0:
        return jsonify({"success": False, "message": "Utente non trovato"}), 404

    return jsonify({"success": True, "message": f"Tag {rfid_tag} assegnato a {username}"})


@app.route("/remove_tag", methods=["POST"])
def remove_tag():
    """Rimuove l'associazione tag RFID da un utente."""
    data     = request.json or {}
    username = data.get("username", "").strip()

    if not username:
        return jsonify({"success": False, "message": "username obbligatorio"}), 400

    result = users_col.update_one(
        {"username": username},
        {"$set": {"rfid_tag": None}}
    )

    if result.matched_count == 0:
        return jsonify({"success": False, "message": "Utente non trovato"}), 404

    return jsonify({"success": True, "message": f"Tag rimosso da {username}"})


# ══════════════════════════════════════════════
# ENDPOINTS — PORTA
# ══════════════════════════════════════════════

@app.route("/stato_porta", methods=["GET"])
def get_stato():
    stato = "Aperta" if door_state["aperta"] else "Bloccata"
    return jsonify({"stato": stato})


@app.route("/apri_porta", methods=["POST"])
def apri_porta():
    data     = request.json or {}
    username = data.get("username", "Utente")
    door_state["aperta"] = True
    add_access_log(username, "APP", is_bloccata=False)
    return "OK", 200


@app.route("/chiudi_porta", methods=["POST"])
def chiudi_porta():
    data     = request.json or {}
    username = data.get("username", "Utente")
    door_state["aperta"] = False
    add_access_log(username, "APP", is_bloccata=True)
    return "OK", 200


# ══════════════════════════════════════════════
# ENDPOINTS — ACCESSI
# ══════════════════════════════════════════════

@app.route("/accessi", methods=["GET"])
def get_accessi():
    docs = list(
        accesses_col.find({}, {"_id": 0}).sort("_id", DESCENDING)
    )
    return jsonify(docs)


@app.route("/accessi/count", methods=["GET"])
def get_accessi_count():
    return jsonify({"count": accesses_col.count_documents({})})


@app.route("/nuovo_accesso", methods=["POST"])
def nuovo_accesso():
    """Chiamato dall'Arduino/ESP quando legge un tag RFID."""
    data   = request.json or {}
    tag_id = data.get("id", "UNKNOWN")

    # Cerca a chi appartiene il tag
    username = get_username_by_tag(tag_id)

    door_state["aperta"] = not door_state["aperta"]
    add_access_log(username, tag_id, is_bloccata=not door_state["aperta"])
    return "OK", 200


# ══════════════════════════════════════════════
# AVVIO
# ══════════════════════════════════════════════

if __name__ == "__main__":
    init_db()
    print(f"\n{'='*40}")
    print(f"  DOORmotic Server avviato (MongoDB)")
    print(f"  Admin: {ADMIN_USERNAME} / {ADMIN_PASSWORD}")
    print(f"  Codice segreto QR: {SECRET_CODE}")
    print(f"{'='*40}\n")
    app.run(host="0.0.0.0", port=5000, debug=True)