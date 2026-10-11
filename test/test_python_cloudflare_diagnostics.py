"""Native tests of the real Workers entry with deterministic Fetch/FFI doubles."""
from __future__ import annotations

import contextlib
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
NOTE_ID = "abcdef1234567890abcdef12"
NOTE = "https://www.xiaohongshu.com/explore/" + NOTE_ID
PRIVATE = "PRIVATE_QUERY_SENTINEL"


class BytesValue(bytes):
    def to_bytes(self):
        return bytes(self)


class Body:
    def __init__(self, raw):
        self.raw = raw
        self.finished = False
        self.cancelled = False
        self.released = False

    def getReader(self):
        return self

    async def read(self):
        if self.finished:
            return types.SimpleNamespace(done=True, value=None)
        self.finished = True
        return types.SimpleNamespace(done=False, value=BytesValue(self.raw))

    async def cancel(self):
        self.cancelled = True

    def releaseLock(self):
        self.released = True


class FetchResponse:
    def __init__(self, data=b"", *, status=200, headers=None):
        self.raw = data.encode() if isinstance(data, str) else data
        self.status = status
        self.headers = Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value
        self.body = Body(self.raw) if self.raw else None


class FetchRequest(FetchResponse):
    def __init__(self, data):
        super().__init__(json.dumps(data).encode(), headers={"Content-Type": "application/json"})
        self.method = "POST"
        self.url = "https://fixture.test/api/python_parse"


class AbortSignal:
    @staticmethod
    def timeout(milliseconds):
        return ("bounded-timeout", milliseconds)


core_spec = importlib.util.spec_from_file_location("diagnostic_parser_core", ROOT / "cloudflare/python/src/parser_core.py")
core = importlib.util.module_from_spec(core_spec)
core_spec.loader.exec_module(core)
js_stub = types.ModuleType("js")
js_stub.AbortSignal = AbortSignal
workers_stub = types.ModuleType("workers")
workers_stub.Request = FetchRequest
workers_stub.Response = FetchResponse
workers_stub.WorkerEntrypoint = object
workers_stub.fetch = None
entry_spec = importlib.util.spec_from_file_location("diagnostic_workers_entry", ROOT / "cloudflare/python/src/entry.py")
api = importlib.util.module_from_spec(entry_spec)
with patch.dict(sys.modules, {"js": js_stub, "workers": workers_stub, "parser_core": core}):
    entry_spec.loader.exec_module(api)


class CloudflareDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def call(self, text, responses):
        requests = []
        queue = list(responses)

        async def fixture_fetch(url, **options):
            requests.append((url, options))
            item = queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        output = io.StringIO()
        with patch.object(api, "fetch", fixture_fetch), contextlib.redirect_stdout(output):
            response = await api.Default().fetch(FetchRequest({"text": text}))
        logs = []
        for line in output.getvalue().splitlines():
            self.assertTrue(line.startswith("CF_NATIVE_PARSE_FAILURE "), line)
            logs.append(json.loads(line.split(" ", 1)[1]))
        for url, options in requests:
            self.assertEqual(options["redirect"], "manual")
            self.assertEqual(options["headers"], api.PAGE_HEADERS)
            self.assertEqual(options["signal"], ("bounded-timeout", 15000))
        self.assertEqual(queue, [], "No extra upstream requests or retries")
        return response.status, json.loads(response.raw), logs, requests

    def assert_private_absent(self, logs):
        serialized = json.dumps(logs, ensure_ascii=False)
        for sentinel in (NOTE_ID, PRIVATE, "PRIVATE_HTML_SENTINEL", "PRIVATE_COOKIE_SENTINEL", "https://", "xsec_token", "rawUrl", "title"):
            self.assertNotIn(sentinel, serialized)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["event"], "xhs_native_parse_failure")
        self.assertEqual(logs[0]["engine"], "python")

    async def test_redirect_captcha_is_friendly_bounded_and_private(self):
        first = FetchResponse(status=302, headers={"Location": "https://www.xiaohongshu.com/captcha?xsec_token=" + PRIVATE})
        second = FetchResponse("<title>小红书安全验证</title>PRIVATE_HTML_SENTINEL", headers={"Set-Cookie": "PRIVATE_COOKIE_SENTINEL"})
        status, body, logs, requests = await self.call("https://xhslink.com/private?xsec_token=" + PRIVATE, [first, second])
        self.assertEqual(status, 422)
        self.assertIn("要求安全验证", body["message"])
        self.assertEqual(len(requests), 2)
        self.assertEqual(logs[0]["failureClass"], "captcha")
        self.assertEqual(logs[0]["phase"], "parse")
        self.assertEqual(logs[0]["upstream"], [
            {"host": "xhslink.com", "pathClass": "shortlink", "status": 302},
            {"host": "www.xiaohongshu.com", "pathClass": "captcha", "status": 200}])
        self.assertTrue(first.body is None or first.body.cancelled)
        self.assert_private_absent(logs)

    async def test_exact_login_title_changes_only_existing_missing_media_422(self):
        status, body, logs, _ = await self.call(NOTE + "?xsec_token=" + PRIVATE, [FetchResponse("<title>小红书 - 登录</title>PRIVATE_HTML_SENTINEL")])
        self.assertEqual(status, 422)
        self.assertIn("要求登录", body["message"])
        self.assertEqual(logs[0]["failureClass"], "login")
        self.assertTrue(logs[0]["noteIdPresent"])
        self.assert_private_absent(logs)

    async def test_general_words_query_and_note_body_do_not_claim_challenge(self):
        html = "<title>captcha login 使用说明</title><p>PRIVATE_HTML_SENTINEL captcha 登录 " + NOTE_ID + "</p>"
        status, body, logs, _ = await self.call(NOTE + "?next=/captcha/login&xsec_token=" + PRIVATE, [FetchResponse(html)])
        self.assertEqual(status, 422)
        self.assertIn("没有解析到", body["message"])
        self.assertEqual(logs[0]["failureClass"], "no-media")
        self.assertFalse(logs[0]["challengeDetected"])
        self.assertFalse(logs[0]["loginDetected"])
        self.assertFalse(logs[0]["currentNotePresent"])
        self.assertEqual(logs[0]["htmlBytes"], len(html.encode()))
        self.assert_private_absent(logs)

    async def test_empty_current_note_structure_is_present_without_media(self):
        for state in ({"note": {"noteDetailMap": {NOTE_ID: {"note": {"imageList": []}}}}},
                      {"noteData": {"noteId": NOTE_ID, "imageList": []}}):
            html = "<script>window.__INITIAL_STATE__=" + json.dumps(state) + ";</script>"
            status, _, logs, _ = await self.call(NOTE, [FetchResponse(html)])
            self.assertEqual(status, 422)
            self.assertTrue(logs[0]["initialStatePresent"])
            self.assertTrue(logs[0]["currentNotePresent"])
            self.assertEqual(logs[0]["strategy"], "not-found")
            self.assert_private_absent(logs)

    async def test_success_is_unchanged_and_does_not_emit_failure(self):
        note = {"noteId": NOTE_ID, "title": "captcha 登录 are ordinary text", "desc": "unchanged",
                "imageList": [{"urlDefault": "https://ci.xiaohongshu.com/fixture/image"}]}
        html = "<title>小红书安全验证</title><script>window.__INITIAL_STATE__=" + json.dumps({"note": {"noteDetailMap": {NOTE_ID: {"note": note}}}}) + ";</script>"
        status, body, logs, requests = await self.call(NOTE, [FetchResponse(html)])
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["strategy"], "exact-initial-state")
        self.assertEqual(logs, [])
        self.assertEqual(len(requests), 1)

    async def test_upstream_status_and_transport_failure_are_preserved(self):
        for response, expected in [(FetchResponse(status=461), 400), (FetchResponse(status=500), 502),
                                   (RuntimeError("https://secret.test/" + PRIVATE), 502)]:
            with self.subTest(expected=expected):
                status, _, logs, requests = await self.call(NOTE + "?xsec_token=" + PRIVATE, [response])
                self.assertEqual(status, expected)
                self.assertEqual(logs[0]["phase"], "fetch")
                self.assertEqual(logs[0]["failureClass"], "fetch-failed")
                self.assertTrue(logs[0]["noteIdPresent"])
                if not isinstance(response, Exception):
                    self.assertEqual(logs[0]["finalHost"], "www.xiaohongshu.com")
                    self.assertEqual(logs[0]["finalPathClass"], "note")
                self.assertEqual(len(requests), 1)
                self.assert_private_absent(logs)

    async def test_unsafe_redirect_is_rejected_before_second_fetch(self):
        status, _, logs, requests = await self.call(NOTE, [FetchResponse(status=302,
            headers={"Location": "https://private.invalid/" + PRIVATE})])
        self.assertEqual(status, 502)
        self.assertEqual(len(requests), 1)
        self.assert_private_absent(logs)

    async def test_page_cap_still_cancels_stream_and_preserves_413(self):
        response = FetchResponse(b"x" * (api.MAX_HTML_BYTES + 1))
        status, _, logs, requests = await self.call(NOTE, [response])
        self.assertEqual(status, 413)
        self.assertTrue(response.body.cancelled)
        self.assertTrue(response.body.released)
        self.assertEqual(len(requests), 1)
        self.assert_private_absent(logs)

    def test_locations_do_not_echo_identifier_query_or_arbitrary_subdomain(self):
        self.assertEqual(api.diagnostic_location("https://secret.xiaohongshu.com/" + PRIVATE), {"host": "other", "pathClass": "other"})
        self.assertEqual(api.diagnostic_location(NOTE + "?next=/captcha/"), {"host": "www.xiaohongshu.com", "pathClass": "note"})
        self.assertEqual(api.diagnostic_location("https://www.xiaohongshu.com/website-login"), {"host": "www.xiaohongshu.com", "pathClass": "login"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
