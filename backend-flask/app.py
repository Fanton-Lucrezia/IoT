from flask import Flask, jsonify, request
from flask_cors import CORS
from datetime import datetime

app = Flask(__name__)
CORS(app)

# Dati simulati
accessi_db = [
    {"id": "123ABC", "orario": "10:30"},
    {"id": "999XYZ", "orario": "10:45"}
]
porta_aperta = False

@app.route("/accessi", methods=["GET"])
def get_accessi():
    return jsonify(accessi_db)

@app.route("/stato_porta", methods=["GET"])
def get_stato():
    status_str = "Aperta" if porta_aperta else "Bloccata"
    return jsonify({"stato": status_str})

@app.route("/nuovo_accesso", methods=["POST"])
def nuovo_accesso():
    global porta_aperta
    data = request.json
    tag_id = data.get("id")
    # Aggiungi al log
    nuovo = {"id": tag_id, "orario": datetime.now().strftime("%H:%M")}
    accessi_db.insert(0, nuovo) # Mette l'ultimo in alto
    porta_aperta = not porta_aperta # Cambia stato
    return "OK", 200

@app.route("/apri_porta", methods=["GET"])
def apri():
    global porta_aperta
    porta_aperta = True
    return "OK", 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

