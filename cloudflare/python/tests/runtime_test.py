"""Exercise the Python API in real workerd with isolated, deterministic upstreams.

Run `uv run pywrangler sync` once, then `uv run python tests/runtime_test.py`.
The production entrypoint, parser, FFI, request/response streams and range
validation run unmodified. Only outbound fetch is replaced by test fixtures.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
NOTE = "https://www.xiaohongshu.com/explore/abcdef1234567890abcdef12"
VIDEO = "https://sns-video-bd.xhscdn.com/fixture.mp4"


class WorkerRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (ROOT / "python_modules/workers").is_dir():
            raise RuntimeError("Run uv run pywrangler sync before this test")
        cls.temp = tempfile.TemporaryDirectory(prefix="xhs-python-worker-")
        project = Path(cls.temp.name)
        (project / "src").mkdir()
        for filename in ("entry.py", "parser_core.py"):
            shutil.copyfile(ROOT / "src" / filename, project / "src" / filename)
        shutil.copyfile(ROOT / "tests/fixture_entry.py", project / "src/fixture_entry.py")
        (project / "python_modules").symlink_to(ROOT / "python_modules", target_is_directory=True)
        config = {"name": "xhs-python-runtime-tests", "main": "src/fixture_entry.py",
            "compatibility_date": "2026-09-22", "compatibility_flags": ["python_workers"]}
        (project / "wrangler.json").write_text(json.dumps(config))
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        cls.base = f"http://127.0.0.1:{port}"
        cls.log = (project / "runtime.log").open("w+")
        cls.proc = subprocess.Popen([
            str(ROOT.parents[1] / "node_modules/.bin/wrangler"), "dev", "--config",
            str(project / "wrangler.json"), "--port", str(port), "--inspector-port", "0",
            "--ip", "127.0.0.1", "--local",
        ], cwd=ROOT, stdout=cls.log, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(180):
            if cls.proc.poll() is not None:
                break
            try:
                cls.call("/api/python-image")
                return
            except (URLError, TimeoutError):
                time.sleep(0.25)
        cls.log.seek(0)
        output = cls.log.read()
        cls.tearDownClass()
        raise RuntimeError("Worker failed to start:\n" + output)

    @classmethod
    def tearDownClass(cls):
        if cls.proc.poll() is None:
            import signal
            os.killpg(cls.proc.pid, signal.SIGTERM)
            cls.proc.wait(timeout=10)
        if os.environ.get("PYTHON_WORKER_TEST_LOG"):
            cls.log.seek(0)
            print(cls.log.read())
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def call(cls, path, body=None, method=None):
        if isinstance(body, dict):
            body = json.dumps(body).encode()
        request = Request(cls.base + path, data=body, method=method,
                          headers={"Content-Type": "application/json"})
        try:
            response = urlopen(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read()
            payload = json.loads(raw) if response.headers.get_content_type() == "application/json" else raw
            return response.status, response.headers, payload

    def test_direct_image_payload(self):
        status, headers, body = self.call("/api/python-parse", {"text": "https://ci.xiaohongshu.com/test/image"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-XHS-Engine"], "python")
        self.assertEqual(body["images"][0]["token"], "test/image")
        self.assertEqual(body["count"], 1)

    def test_full_note_live_photo_video_audio(self):
        status, _, body = self.call("/api/python-parse", {"text": "https://xhslink.com/valid"})
        self.assertEqual(status, 200)
        self.assertEqual(body["title"], "测试笔记")
        self.assertEqual(body["content"], "原始正文")
        self.assertEqual(body["type"], "mixed")
        self.assertEqual(body["livePhotoCount"], 1)
        self.assertEqual(body["images"][0]["liveVideo"]["duration"], 2500)
        self.assertEqual(body["videos"][0]["audioCodec"], "aac")
        self.assertEqual(body["videos"][0]["hasAudio"], True)

    def test_note_errors_and_input_limits(self):
        for body, expected in [({}, 400), ({"text": "https://example.com"}, 400),
            ({"text": NOTE + "?case=blocked"}, 400), ({"text": NOTE + "?case=empty"}, 502),
            ({"text": NOTE + "?case=missing"}, 422), ({"text": NOTE + "?case=large"}, 413),
            ({"text": "x" * 3001}, 413), (b"x" * 16385, 413), (b"{", 400)]:
            with self.subTest(expected=expected, body=str(body)[:80]):
                self.assertEqual(self.call("/api/python-parse", body)[0], expected)

    def test_redirects_rejected_before_fetch(self):
        cases = [("/api/python-parse", {"text": "https://xhslink.com/test?case=unsafe"}),
                 ("/api/python-image?token=redirect", None),
                 ("/api/python-video?" + urlencode({"url": VIDEO + "?case=unsafe"}), None)]
        for path, body in cases:
            with self.subTest(path=path):
                status, _, result = self.call(path, body)
                self.assertEqual(status, 502)
                self.assertIn("不受支持", result["message"])

    def test_image_bytes_filename_and_limit(self):
        status, headers, body = self.call("/api/python-image?" + urlencode({"token": "image", "name": '测试".jpg'}))
        self.assertEqual(status, 200)
        self.assertEqual(body, b"\xff\xd8image\xff\xd9")
        self.assertEqual(headers["Content-Disposition"], 'attachment; filename="_.jpg"')
        for token, status in [("../unsafe", 400), ("html", 502), ("large", 413)]:
            self.assertEqual(self.call("/api/python-image?" + urlencode({"token": token}))[0], status)

    def test_video_meta(self):
        status, _, body = self.call("/api/python-video?" + urlencode({"url": VIDEO}))
        self.assertEqual(status, 200)
        self.assertEqual(body["size"], 6)
        self.assertTrue(body["acceptRanges"])
        self.assertEqual(body["chunkSize"], 3_500_000)
        self.assertEqual(self.call("/api/python-video?" + urlencode({"url": VIDEO + "?case=large"}))[0], 413)

    def test_video_chunk_integrity(self):
        args = {"url": VIDEO, "action": "chunk", "start": "1", "end": "3"}
        status, headers, body = self.call("/api/python-video?" + urlencode(args))
        self.assertEqual((status, body), (200, b"bcd"))
        self.assertEqual(headers["Content-Range"], "bytes 1-3/6")
        self.assertEqual(headers["X-Video-Total"], "6")
        for scenario, expected in [("mismatch", 502), ("truncated", 502), ("no-range", 409)]:
            args["url"] = VIDEO + "?case=" + scenario
            self.assertEqual(self.call("/api/python-video?" + urlencode(args))[0], expected)
        args.update(url=VIDEO, start=0, end=3_500_000)
        self.assertEqual(self.call("/api/python-video?" + urlencode(args))[0], 413)

    def test_methods_aliases_and_missing_route(self):
        self.assertEqual(self.call("/api/python-parse", method="OPTIONS")[0], 204)
        self.assertEqual(self.call("/api/python-parse")[0], 405)
        self.assertEqual(self.call("/api/python-image", {}, "POST")[0], 405)
        self.assertEqual(self.call("/api/other")[0], 404)
        self.assertEqual(self.call("/api/python_parse.py", {"text": "https://ci.xiaohongshu.com/image"})[0], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
