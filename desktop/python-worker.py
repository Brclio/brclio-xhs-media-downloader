"""Run the unchanged Python web handlers over private stdin/stdout, without a port."""
from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import sys
from email.message import Message
from pathlib import Path

# PyInstaller includes certifi so HTTPS works on machines without Python/certificates.
try:
    import certifi
    os.environ["SSL_CERT_FILE"] = certifi.where()
except ImportError:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api.python_parse import handler as ParseHandler
from api.python_image import handler as ImageHandler
from api.python_video import handler as VideoHandler

HANDLERS = {"/api/python_parse": ParseHandler, "/api/python_image": ImageHandler,
            "/api/python_video": VideoHandler}


def dispatch(request):
    route = str(request.get("path", "")).split("?", 1)[0]
    handler_type = HANDLERS.get(route)
    if not handler_type:
        raise ValueError("Unsupported Python endpoint")
    method = str(request.get("method", "GET"))
    body = str(request.get("body", "")).encode("utf-8")
    handler = object.__new__(handler_type)
    handler.path = str(request["path"])
    handler.command = method
    handler.headers = Message()
    for name, value in request.get("headers", {}).items():
        handler.headers[str(name)] = str(value)
    handler.headers.replace_header("Content-Length", str(len(body))) if "Content-Length" in handler.headers else handler.headers.add_header("Content-Length", str(len(body)))
    handler.rfile = io.BytesIO(body)
    handler.wfile = io.BytesIO()
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


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--health":
        print(json.dumps({"ok": True, "engine": "python", "version": sys.version.split()[0]}))
        return
    try:
        request = json.loads(sys.stdin.buffer.read(65537))
        result = dispatch(request)
    except Exception as error:
        print(repr(error), file=sys.stderr)
        result = {"status": 500, "headers": {"Content-Type": "application/json"},
                  "body": base64.b64encode(json.dumps({"success": False, "message": "Python 本地后台请求失败。"}).encode()).decode()}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
