"""
DOORmotic - Flask Server
========================
Avvio: python flask_server.py
Accesso admin di default: username=admin, password=admin

Per migrare a MySQL con XAMPP:
  Sostituire le funzioni load_users()/save_users() e load_accesses()/save_accesses()
  con query pymysql. Il resto del codice rimane identico.
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from datetime import datetime
import hashlib
import json
import os

app = Flask(__name__)
CORS(app)

# ══════════════════════════════════════════════
# CONFIGURAZIONE
# ══════════════════════════════════════════════
SECRET_CODE    = "DOORMOTIC2026"   # ← Codice segreto da mettere nel QR
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "admin"           # ← Cambia in produzione

USERS_FILE    = "users.json"
ACCESSES_FILE = "accesses.json"

door_state = {"aperta": False}


# ══════════════════════════════════════════════
# DATABASE (JSON)
# ══════════════════════════════════════════════

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def init_db():
    if not os.path.exists(USERS_FILE):
        users = {
            ADMIN_USERNAME: {
                "password": hash_password(ADMIN_PASSWORD),
                "role": "admin",
                "has_door_access": True
            }
        }
        with open(USERS_FILE, "w") as f:
            json.dump(users, f, indent=2)
        print(f"[DB] Creato {USERS_FILE} con utente admin")

    if not os.path.exists(ACCESSES_FILE):
        with open(ACCESSES_FILE, "w") as f:
            json.dump([], f)
        print(f"[DB] Creato {ACCESSES_FILE}")

def load_users() -> dict:
    with open(USERS_FILE, "r") as f:
        return json.load(f)

def save_users(users: dict):
    with open(USERS_FILE, "w") as f:
        json.dump(users, f, indent=2)

def load_accesses() -> list:
    with open(ACCESSES_FILE, "r") as f:
        return json.load(f)

def save_accesses(accesses: list):
    with open(ACCESSES_FILE, "w") as f:
        json.dump(accesses, f, indent=2)

def add_access_log(username: str, tag_id: str, azione: str):
    accesses = load_accesses()
    accesses.insert(0, {
        "username": username,
        "tag_id": tag_id,
        "orario": datetime.now().strftime("%H:%M"),
        "data": datetime.now().strftime("%d/%m/%Y"),
        "azione": azione
    })
    save_accesses(accesses)


# ══════════════════════════════════════════════
# ENDPOINTS — AUTENTICAZIONE
# ══════════════════════════════════════════════

@app.route("/login", methods=["POST"])
def login():
    data = request.json or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    users = load_users()

    if username not in users:
        return jsonify({"success": False, "message": "Utente non trovato"}), 401

    user = users[username]
    if user["password"] != hash_password(password):
        return jsonify({"success": False, "message": "Password errata"}), 401

    return jsonify({
        "success": True,
        "username": username,
        "role": user["role"],
        "has_door_access": user["has_door_access"]
    })


@app.route("/register", methods=["POST"])
def register():
    data = request.json or {}
    username    = data.get("username", "").strip()
    password    = data.get("password", "")
    secret_code = data.get("secret_code", "").strip()

    if not username or not password:
        return jsonify({"success": False, "message": "Compila tutti i campi"}), 400

    if len(password) < 6:
        return jsonify({"success": False, "message": "Password troppo corta (min 6 caratteri)"}), 400

    users = load_users()

    if username in users:
        return jsonify({"success": False, "message": "Username già in uso"}), 400

    has_access = (secret_code == SECRET_CODE)

    users[username] = {
        "password": hash_password(password),
        "role": "user",
        "has_door_access": has_access
    }
    save_users(users)

    if has_access:
        msg = "Registrazione completata! Hai accesso alla porta."
    else:
        msg = "Registrazione completata. Senza codice valido non puoi aprire la porta."

    return jsonify({"success": True, "message": msg, "has_door_access": has_access})


# ══════════════════════════════════════════════
# ENDPOINTS — PORTA
# ══════════════════════════════════════════════

@app.route("/stato_porta", methods=["GET"])
def get_stato():
    stato = "Aperta" if door_state["aperta"] else "Bloccata"
    return jsonify({"stato": stato})


@app.route("/apri_porta", methods=["POST"])
def apri_porta():
    data = request.json or {}
    username = data.get("username", "Utente")
    door_state["aperta"] = True
    add_access_log(username, "APP", "Aperta")
    return "OK", 200


@app.route("/chiudi_porta", methods=["POST"])
def chiudi_porta():
    data = request.json or {}
    username = data.get("username", "Utente")
    door_state["aperta"] = False
    add_access_log(username, "APP", "Bloccata")
    return "OK", 200


# ══════════════════════════════════════════════
# ENDPOINTS — ACCESSI
# ══════════════════════════════════════════════

@app.route("/accessi", methods=["GET"])
def get_accessi():
    return jsonify(load_accesses())


@app.route("/accessi/count", methods=["GET"])
def get_accessi_count():
    return jsonify({"count": len(load_accesses())})


@app.route("/nuovo_accesso", methods=["POST"])
def nuovo_accesso():
    data = request.json or {}
    tag_id = data.get("id", "UNKNOWN")
    door_state["aperta"] = not door_state["aperta"]
    azione = "Aperta" if door_state["aperta"] else "Bloccata"
    add_access_log("RFID", tag_id, azione)
    return "OK", 200


# ══════════════════════════════════════════════
# AVVIO
# ══════════════════════════════════════════════

if __name__ == "__main__":
    init_db()
    print(f"\n{'='*40}")
    print(f"  DOORmotic Server avviato")
    print(f"  Admin: {ADMIN_USERNAME} / {ADMIN_PASSWORD}")
    print(f"  Codice segreto QR: {SECRET_CODE}")
    print(f"{'='*40}\n")


    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
    #app.run(host="0.0.0.0", port=5000, debug=True)