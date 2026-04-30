"""
DOORmotic - Flask Server
========================
Variabili Railway:
  MONGO_URI, ADMIN_PASS, SECRET_CODE
  MQTT_BROKER, MQTT_PORT, MQTT_USER, MQTT_PASSWORD
"""

import os, json, hashlib, threading
from flask import Flask, jsonify, request, Response
from flask_cors import CORS
from datetime import datetime
from pymongo import MongoClient
import paho.mqtt.client as mqtt_lib

app = Flask(__name__)
CORS(app)

SECRET_CODE    = os.environ.get("SECRET_CODE",   "DOORMOTIC2026")
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASS",    "admin")
MONGO_URI      = os.environ.get("MONGO_URI",     "")
MQTT_BROKER    = os.environ.get("MQTT_BROKER",   "")
MQTT_PORT      = int(os.environ.get("MQTT_PORT", "8883"))
MQTT_USER      = os.environ.get("MQTT_USER",     "")
MQTT_PASSWORD  = os.environ.get("MQTT_PASSWORD", "")
TOPIC_OUT      = "doormotic/comandi/porta1"

# ── MongoDB ───────────────────────────────────────────────────────────────────
db = None
if MONGO_URI:
    client = MongoClient(MONGO_URI)
    db = client["doormotic"]
    print("[DB] MongoDB connesso")
else:
    print("[WARNING] MONGO_URI non impostato — modalità RAM")

door_state  = {"aperta": False}
_ram_users  = {}
_ram_access = []

# ── MQTT ──────────────────────────────────────────────────────────────────────
mqtt_client = None

def setup_mqtt():
    global mqtt_client
    if not MQTT_BROKER:
        print("[MQTT] MQTT_BROKER non impostato — controllo remoto disabilitato")
        return
    mqtt_client = mqtt_lib.Client(client_id="flask_server", protocol=mqtt_lib.MQTTv311)
    mqtt_client.username_pw_set(MQTT_USER, MQTT_PASSWORD)
    mqtt_client.tls_set()
    mqtt_client.on_connect    = lambda c, u, f, rc: print(f"[MQTT] {'✅ connesso' if rc==0 else f'❌ rc={rc}'}")
    mqtt_client.on_disconnect = lambda c, u, rc: print(f"[MQTT] disconnesso rc={rc}")
    try:
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT, keepalive=60)
        threading.Thread(target=mqtt_client.loop_forever, daemon=True).start()
    except Exception as e:
        print(f"[MQTT] Errore: {e}")
        mqtt_client = None

def mqtt_publish(payload: str):
    if mqtt_client and mqtt_client.is_connected():
        mqtt_client.publish(TOPIC_OUT, payload)
        print(f"[MQTT] → {payload}")
    else:
        print(f"[MQTT] Non connesso — '{payload}' non inviato")

# ── Helpers ───────────────────────────────────────────────────────────────────
def hash_pw(pw): return hashlib.sha256(pw.encode()).hexdigest()

def safe_json(obj):
    if isinstance(obj, datetime): return obj.strftime("%d/%m/%Y %H:%M")
    raise TypeError(f"Non serializzabile: {type(obj)}")

def json_resp(data):
    return Response(json.dumps(data, default=safe_json), mimetype="application/json")

def get_user(username):
    # FIX: confronta con None invece di usare db come booleano
    return db["users"].find_one({"_id": username}) if db is not None else _ram_users.get(username)

def save_user(username, data):
    # FIX: confronta con None invece di usare db come booleano
    if db is not None:
        db["users"].update_one({"_id": username}, {"$set": data}, upsert=True)
    else:
        _ram_users[username] = data

def add_access_log(username, tag_id, azione, source="APP"):
    now = datetime.utcnow()
    entry = {
        "username":  username,
        "tag_id":    tag_id,
        "orario":    now.strftime("%H:%M"),
        "data":      now.strftime("%d/%m/%Y"),
        "azione":    azione,
        "source":    source,
        "timestamp": now
    }
    # FIX: confronta con None invece di usare db come booleano
    if db is not None:
        db["accesses"].insert_one(entry)
    else:
        _ram_access.insert(0, {k:v for k,v in entry.items() if k!="timestamp"})

def get_accesses_list(limit=5):
    # FIX: confronta con None invece di usare db come booleano
    if db is not None:
        return list(db["accesses"]
                    .find({}, {"_id": 0, "timestamp": 0})
                    .sort("timestamp", -1)
                    .limit(limit))
    return _ram_access[:limit]

# ── Init admin ────────────────────────────────────────────────────────────────
def init_admin():
    save_user(ADMIN_USERNAME, {
        "_id":             ADMIN_USERNAME,
        "password":        hash_pw(ADMIN_PASSWORD),
        "is_admin":        True,
        "has_door_access": True
    })
    print(f"[DB] Admin '{ADMIN_USERNAME}' pronto")

# ── Autenticazione ────────────────────────────────────────────────────────────
@app.route("/login", methods=["POST"])
def login():
    data     = request.json or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    user = get_user(username)
    if not user:
        return jsonify({"success": False, "message": "Utente non trovato"}), 401
    if user["password"] != hash_pw(password):
        return jsonify({"success": False, "message": "Password errata"}), 401
    return jsonify({
        "success":         True,
        "username":        username,
        "is_admin":        user.get("is_admin", False),
        "has_door_access": user.get("has_door_access", False)
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
        return jsonify({"success": False, "message": "Password troppo corta (min 6)"}), 400
    if get_user(username):
        return jsonify({"success": False, "message": "Username già in uso"}), 400
    has_access = (secret_code == SECRET_CODE)
    save_user(username, {
        "_id": username, "password": hash_pw(password),
        "is_admin": False, "has_door_access": has_access
    })
    msg = "Registrato! Hai accesso alla porta." if has_access \
          else "Registrato. Senza codice non puoi aprire la porta."
    return jsonify({"success": True, "message": msg, "has_door_access": has_access})

# ── Porta ─────────────────────────────────────────────────────────────────────
@app.route("/stato_porta", methods=["GET"])
def get_stato():
    return jsonify({"stato": "Aperta" if door_state["aperta"] else "Bloccata"})

@app.route("/apri_porta", methods=["POST"])
def apri_porta():
    username = (request.json or {}).get("username", "Utente")
    door_state["aperta"] = True
    add_access_log(username, "APP", "Aperta")
    mqtt_publish("apri")
    return "OK", 200

@app.route("/chiudi_porta", methods=["POST"])
def chiudi_porta():
    username = (request.json or {}).get("username", "Utente")
    door_state["aperta"] = False
    add_access_log(username, "APP", "Bloccata")
    mqtt_publish("chiudi")
    return "OK", 200

# ── Accessi ───────────────────────────────────────────────────────────────────
@app.route("/accessi", methods=["GET"])
def get_accessi():
    try:
        limit = int(request.args.get("limit", 5))
        limit = max(1, min(limit, 100))
    except ValueError:
        limit = 5
    return json_resp(get_accesses_list(limit))

@app.route("/accessi/count", methods=["GET"])
def get_accessi_count():
    # FIX: confronta con None invece di usare db come booleano
    count = db["accesses"].count_documents({}) if db is not None else len(_ram_access)
    return jsonify({"count": count})

@app.route("/nuovo_accesso", methods=["POST"])
def nuovo_accesso():
    tag_id = (request.json or {}).get("id", "UNKNOWN")
    door_state["aperta"] = not door_state["aperta"]
    azione = "Aperta" if door_state["aperta"] else "Bloccata"
    add_access_log("RFID", tag_id, azione, source="RFID")
    return "OK", 200

# ── Tag RFID ──────────────────────────────────────────────────────────────────
@app.route("/tags", methods=["GET"])
def list_tags():
    if db is None: return jsonify([])
    return json_resp(list(db["tags"].find({}, {"_id": 0})))

@app.route("/tags/<tag_id>", methods=["PATCH"])
def update_tag(tag_id):
    if db is None:
        return jsonify({"success": False, "message": "DB non disponibile"}), 500
    data   = request.json or {}
    update = {}
    if "label"           in data: update["label"]           = data["label"]
    if "has_door_access" in data: update["has_door_access"] = bool(data["has_door_access"])
    if not update:
        return jsonify({"success": False, "message": "Nessun campo da aggiornare"}), 400
    result = db["tags"].update_one({"_id": tag_id.upper()}, {"$set": update})
    if result.matched_count == 0:
        return jsonify({"success": False, "message": "Tag non trovato"}), 404
    return jsonify({"success": True})

# ── Avvio ─────────────────────────────────────────────────────────────────────
init_admin()
setup_mqtt()

if __name__ == "__main__":
    print(f"\n{'='*45}")
    print(f"  DOORmotic Flask Server")
    print(f"  MongoDB:  {'✅ connesso' if db is not None else '❌ RAM only'}")
    print(f"  MQTT:     {'✅ ' + MQTT_BROKER if MQTT_BROKER else '❌ non configurato'}")
    print(f"  Admin:    {ADMIN_USERNAME} / {ADMIN_PASSWORD}")
    print(f"{'='*45}\n")
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)