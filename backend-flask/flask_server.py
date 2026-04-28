"""
DOORmotic - Flask Server con MongoDB
=====================================
Dipendenze: pip install flask flask-cors pymongo[srv]

Variabili d'ambiente su Railway:
  MONGO_URI   → mongodb+srv://user:pass@cluster.mongodb.net/doormotic
  SECRET_CODE → codice QR (default: DOORMOTIC2026)
  ADMIN_PASS  → password admin (default: admin)
"""

import os
import json
from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from datetime import datetime
import hashlib

from pymongo import MongoClient

app = Flask(__name__)
CORS(app)

# ── Configurazione ────────────────────────────────────────────────────────────
SECRET_CODE    = os.environ.get("SECRET_CODE", "DOORMOTIC2026")
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASS", "admin")
MONGO_URI      = os.environ.get("MONGO_URI", "")

# ── Connessione MongoDB ───────────────────────────────────────────────────────
if MONGO_URI:
    client = MongoClient(MONGO_URI)
    db     = client["doormotic"]
    print("[DB] MongoDB connesso")
else:
    client = None
    db     = None
    print("[WARNING] MONGO_URI non impostato — uso RAM")

door_state = {"aperta": False}

# Fallback RAM
_ram_users    = {}
_ram_accesses = []


# ── Serializzatore JSON sicuro (gestisce datetime e ObjectId) ─────────────────
def safe_json(obj):
    """Converte tipi MongoDB non serializzabili in stringa."""
    if isinstance(obj, datetime):
        return obj.strftime("%d/%m/%Y %H:%M")
    raise TypeError(f"Non serializzabile: {type(obj)}")

def json_response(data):
    """Usa json.dumps con il serializzatore sicuro."""
    return Response(
        json.dumps(data, default=safe_json),
        mimetype="application/json"
    )


# ── Helpers DB ────────────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def get_user(username: str):
    if db is not None:
        return db["users"].find_one({"_id": username})
    return _ram_users.get(username)

def save_user(username: str, data: dict):
    if db is not None:
        db["users"].update_one({"_id": username}, {"$set": data}, upsert=True)
    else:
        _ram_users[username] = data

def add_access_log(username: str, tag_id: str, azione: str):
    now = datetime.utcnow()
    entry = {
        "username":  username,
        "tag_id":    tag_id,
        "orario":    now.strftime("%H:%M"),
        "data":      now.strftime("%d/%m/%Y"),
        "azione":    azione,
        "timestamp": now          # usato solo per ordinamento, non viene mandato all'app
    }
    if db is not None:
        db["accesses"].insert_one(entry)
    else:
        _ram_accesses.insert(0, entry.copy())

def get_accesses_list():
    """Restituisce lista di dict senza _id e senza timestamp (non serve all'app)."""
    if db is not None:
        docs = list(
            db["accesses"]
            .find({}, {"_id": 0, "timestamp": 0})   # escludi _id e timestamp
            .sort("timestamp", -1)
            .limit(100)
        )
        return docs
    # RAM: rimuovi timestamp
    return [
        {k: v for k, v in e.items() if k != "timestamp"}
        for e in _ram_accesses[:100]
    ]

def count_accesses():
    if db is not None:
        return db["accesses"].count_documents({})
    return len(_ram_accesses)


# ── Init admin ────────────────────────────────────────────────────────────────
def init_admin():
    if get_user(ADMIN_USERNAME) is None:
        save_user(ADMIN_USERNAME, {
            "_id":             ADMIN_USERNAME,
            "password":        hash_password(ADMIN_PASSWORD),
            "role":            "admin",
            "has_door_access": True
        })
        print(f"[DB] Creato utente admin '{ADMIN_USERNAME}'")


# ── Endpoints: Autenticazione ─────────────────────────────────────────────────
@app.route("/login", methods=["POST"])
def login():
    data     = request.json or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    user = get_user(username)
    if not user:
        return jsonify({"success": False, "message": "Utente non trovato"}), 401
    if user["password"] != hash_password(password):
        return jsonify({"success": False, "message": "Password errata"}), 401
    return jsonify({
        "success":         True,
        "username":        username,
        "role":            user["role"],
        "has_door_access": user["has_door_access"]
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
    if get_user(username):
        return jsonify({"success": False, "message": "Username già in uso"}), 400
    has_access = (secret_code == SECRET_CODE)
    save_user(username, {
        "_id":             username,
        "password":        hash_password(password),
        "role":            "user",
        "has_door_access": has_access
    })
    msg = "Registrazione completata! Hai accesso alla porta." if has_access \
          else "Registrazione completata. Senza codice non puoi aprire la porta."
    return jsonify({"success": True, "message": msg, "has_door_access": has_access})


# ── Endpoints: Porta ──────────────────────────────────────────────────────────
@app.route("/stato_porta", methods=["GET"])
def get_stato():
    return jsonify({"stato": "Aperta" if door_state["aperta"] else "Bloccata"})

@app.route("/apri_porta", methods=["POST"])
def apri_porta():
    username = (request.json or {}).get("username", "Utente")
    door_state["aperta"] = True
    add_access_log(username, "APP", "Aperta")
    print(f"[PORTA] Aperta da {username}")
    return "OK", 200

@app.route("/chiudi_porta", methods=["POST"])
def chiudi_porta():
    username = (request.json or {}).get("username", "Utente")
    door_state["aperta"] = False
    add_access_log(username, "APP", "Bloccata")
    print(f"[PORTA] Bloccata da {username}")
    return "OK", 200


# ── Endpoints: Accessi ────────────────────────────────────────────────────────
@app.route("/accessi", methods=["GET"])
def get_accessi():
    return json_response(get_accesses_list())

@app.route("/accessi/count", methods=["GET"])
def get_accessi_count():
    return jsonify({"count": count_accesses()})

@app.route("/nuovo_accesso", methods=["POST"])
def nuovo_accesso():
    tag_id = (request.json or {}).get("id", "UNKNOWN")
    door_state["aperta"] = not door_state["aperta"]
    azione = "Aperta" if door_state["aperta"] else "Bloccata"
    add_access_log("RFID", tag_id, azione)
    print(f"[RFID] Tag {tag_id} → {azione}")
    return "OK", 200


# ── Avvio ─────────────────────────────────────────────────────────────────────
init_admin()

if __name__ == "__main__":
    print(f"\n{'='*45}")
    print(f"  DOORmotic Server")
    print(f"  MongoDB: {'connesso ✓' if db is not None else 'NON connesso (RAM)'}")
    print(f"  Admin: {ADMIN_USERNAME} / {ADMIN_PASSWORD}")
    print(f"  Codice QR: {SECRET_CODE}")
    print(f"{'='*45}\n")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)