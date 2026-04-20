from flask import Blueprint, request, jsonify
from IoT_backend.controllers.scan_controller import handle_scan

scan_bp = Blueprint("scan", __name__)

@scan_bp.route("/scan", methods=["POST"])
def scan():
    data = request.json
    uid = data.get("uid")

    result = handle_scan(uid)

    return jsonify(result)