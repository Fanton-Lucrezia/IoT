from flask import Flask, request, jsonify
import mysql.connector

app = Flask(__name__)

# Connessione DB
db = mysql.connector.connect(
    host="localhost",
    user="root",
    password="5AII-ROSSI",
    database="iot_access"
)

@app.route("/scan", methods=["POST"])
def scan():
    data = request.json
    uid = data.get("uid")

    cursor = db.cursor(dictionary=True)

    # Cerca utente
    cursor.execute("SELECT * FROM users WHERE rfid_uid = %s AND active = TRUE", (uid,))
    user = cursor.fetchone()

    if user:
        # Log accesso OK
        cursor.execute(
            "INSERT INTO access_logs (user_id, status) VALUES (%s, %s)",
            (user["id"], "OK")
        )
        db.commit()

        return jsonify({"success": True, "user": user["name"]})
    else:
        return jsonify({"success": False})

if __name__ == "__main__":
    app.run(debug=True)