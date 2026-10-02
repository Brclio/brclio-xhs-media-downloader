"""Run the existing Python API handlers without opening another network port."""
from __future__ import annotations

import base64
import contextlib
import io
import json
import sys
from email.message import Message
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api.python_parse import handler as ParseHandler
from api.python_image import handler as ImageHandler
from api.python_video import handler as VideoHandler

HANDLERS = {"/api/python_parse": ParseHandler, "/api/python_image": ImageHandler,
            "/api/python_video": VideoHandler}


def dispatch(request):
    handler_type = HANDLERS[request["path"].split("?", 1)[0]]
    method = request["method"]
    body = request.get("body", "").encode("utf-8")
    handler = object.__new__(handler_type)
    handler.path = request["path"]
    handler.command = method
    handler.headers = Message()
    handler.headers["Content-Length"] = str(len(body))
    handler.headers["Content-Type"] = "application/json"
    handler.rfile, handler.wfile = io.BytesIO(body), io.BytesIO()
    response = {"status": 200, "headers": {}}
    handler.send_response = lambda status, *args: response.update(status=status)
    handler.send_header = lambda name, value: response["headers"].update({str(name): str(value)})
    handler.end_headers = lambda: None
    callback = getattr(handler, "do_" + method, None)
    with contextlib.redirect_stdout(sys.stderr):
        if callback:
            callback()
        else:
            response["status"] = 405
            response["headers"]["Allow"] = "GET, POST, OPTIONS"
    response["body"] = base64.b64encode(handler.wfile.getvalue()).decode("ascii")
    return response


if __name__ == "__main__":
    if sys.argv[1:] == ["--health"]:
        print(json.dumps({"ok": True, "engine": "python"}))
    else:
        try:
            raw = sys.stdin.buffer.read(131073)
            if len(raw) > 131072:
                raise ValueError("Request too large")
            result = dispatch(json.loads(raw))
        except Exception:
            result = {"status": 503, "headers": {"Content-Type": "application/json"},
                      "body": base64.b64encode(json.dumps({"success": False, "message": "Python 服务暂时不可用。"}).encode()).decode()}
        print(json.dumps(result, ensure_ascii=True))
