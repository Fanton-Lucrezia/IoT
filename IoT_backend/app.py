from flask import Flask, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

@app.route("/accessi")
def accessi():
    return jsonify([
        {"id": "123ABC", "orario": "10:30"},
        {"id": "999XYZ", "orario": "10:45"}
    ])

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)