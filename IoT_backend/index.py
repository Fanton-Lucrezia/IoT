from flask import Flask
from routes.scan_routes import scan_bp

app = Flask(__name__)

app.register_blueprint(scan_bp)

if __name__ == "__main__":
    app.run(debug=True)