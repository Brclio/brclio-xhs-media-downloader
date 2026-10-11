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
from unittest.mock import AsyncMock, patch

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
    def __init__(self, data, *, path="/api/python_parse", method="POST"):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
        super().__init__(raw, headers={"Content-Type": "application/json"})
        self.method = method
        self.url = "https://fixture.test" + path


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


class RenderedNoteBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def page(self, *, protected=False, original_only=False):
        ordinary = "https://sns-video-bd.xhscdn.com/stream/fixture.mp4"
        original = "https://sns-video-bd.xhscdn.com/spectrum/PRIVATE_ORIGINAL_SENTINEL"
        stream = {"masterUrl": original if protected else ordinary,
                  "audioChannels": 2, "audioCodec": "aac", "width": 1080, "height": 1920}
        if protected and not original_only:
            stream["backupUrls"] = [ordinary, original]
        note = {"noteId": NOTE_ID, "title": "测试笔记", "desc": "原始正文",
            "imageList": [] if original_only else [{"urlDefault": "https://ci.xiaohongshu.com/fixture/image",
                "livePhoto": True, "stream": {"h264": [stream]}}],
            "video": {"media": {"stream": {"h264": [stream]}}}}
        if original_only:
            note["video"]["consumer"] = {"originVideoKey": "spectrum/PRIVATE_ORIGINAL_SENTINEL"}
        return "<script>window.__INITIAL_STATE__=" + json.dumps(
            {"note": {"noteDetailMap": {NOTE_ID: {"note": note}}}}, ensure_ascii=False) + ";</script>"

    def envelope(self, **overrides):
        return {"finalUrl": NOTE + "?xsec_token=" + PRIVATE, "html": self.page(), "noteId": NOTE_ID, **overrides}

    async def call(self, body, *, path=api.RENDERED_NOTE_PATH, method="POST", headers=None):
        request = FetchRequest(body, path=path, method=method)
        for key, value in (headers or {}).items():
            request.headers[key] = value
        output = io.StringIO()
        no_fetch = AsyncMock(side_effect=AssertionError("Private HTML parsing must not fetch"))
        with patch.object(api, "fetch", no_fetch), contextlib.redirect_stdout(output):
            response = await api.Default().fetch(request)
        no_fetch.assert_not_awaited()
        return response.status, json.loads(response.raw), output.getvalue(), request, response

    async def test_private_parser_matches_network_response_without_fetch(self):
        page = self.page()
        with patch.object(api, "parse_note_html", wraps=core.parse_note_html) as independent_parser:
            status, body, logs, _, response = await self.call(self.envelope(html=page))
        independent_parser.assert_called_once_with(page, NOTE_ID)
        self.assertEqual(status, 200)
        self.assertEqual((body["engine"], body["strategy"], body["count"], body["videoCount"]),
                         ("python", "exact-initial-state", 1, 1))
        self.assertEqual(body["videos"][0]["audioCodec"], "aac")
        self.assertEqual(body["livePhotoCount"], 1)
        self.assertEqual(logs, "")
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")
        with patch.object(api, "fetch", AsyncMock(return_value=FetchResponse(page))):
            native = await api.Default().fetch(FetchRequest({"text": NOTE}))
        self.assertEqual(body, json.loads(native.raw), "Private and public paths share the same Python response factory")

    async def test_protected_main_backup_and_live_video_urls_stay_redacted(self):
        status, body, _, _, _ = await self.call(self.envelope(html=self.page(protected=True)))
        self.assertEqual(status, 200)
        self.assertEqual(body["videos"][0]["url"], "https://sns-video-bd.xhscdn.com/stream/fixture.mp4")
        self.assertEqual(body["videos"][0]["backupUrls"], [])
        self.assertNotIn("PRIVATE_ORIGINAL_SENTINEL", json.dumps(body))
        self.assertNotIn("spectrum/", json.dumps(body))
        status, body, _, _, _ = await self.call(self.envelope(html=self.page(protected=True, original_only=True)))
        self.assertEqual(status, 200)
        self.assertEqual(body["videos"], [])
        self.assertEqual(body["originalVideoCount"], 1)
        self.assertTrue(body["hasOriginalVideo"])
        self.assertNotIn("spectrum/", json.dumps(body))

    async def test_exact_schema_rejects_network_cookie_and_node_result_overrides(self):
        cases = [[], None, {}, self.envelope(noteId=24), self.envelope(html={}), self.envelope(finalUrl=[])]
        for extra in ("cookie", "cookies", "headers", "token", "url", "text", "images", "engine"):
            cases.append({**self.envelope(), extra: PRIVATE})
        for body in cases:
            with self.subTest(kind=type(body).__name__):
                self.assertEqual((await self.call(body))[0], 400)

    async def test_url_and_note_identity_are_checked_before_parsing(self):
        invalid = ["http://www.xiaohongshu.com/explore/" + NOTE_ID,
            "https://www.xiaohongshu.com.evil.test/explore/" + NOTE_ID,
            "https://www.xiaohongshu.com@evil.test/explore/" + NOTE_ID,
            "https://user:secret@www.xiaohongshu.com/explore/" + NOTE_ID,
            "https://www.xiaohongshu.com:8443/explore/" + NOTE_ID,
            "https://www.xiaohongshu.com:invalid/explore/" + NOTE_ID,
            "https://xhslink.com/explore/" + NOTE_ID,
            NOTE + "/other", NOTE + "#other", NOTE + ";other", NOTE.replace("/explore/", "/other/explore/"),
            NOTE.replace("/explore/", "/explore%2F"), NOTE + "\n", NOTE + "\\other",
            "https://www.xiaohongshu.com/captcha?noteId=" + NOTE_ID]
        with patch.object(api, "parse_note_html", side_effect=AssertionError("Invalid identity entered parser")):
            for url in invalid:
                with self.subTest(url=url):
                    self.assertEqual((await self.call(self.envelope(finalUrl=url)))[0], 400)
            for note_id in ("other1234567890abcdef1234", "a" * 11, "a" * 65, "../" + NOTE_ID):
                self.assertEqual((await self.call(self.envelope(noteId=note_id)))[0], 400)

    async def test_allowed_note_routes_queries_and_default_https_port(self):
        for url in (NOTE, "https://xiaohongshu.com/item/" + NOTE_ID,
                    "https://www.xiaohongshu.com:443/discovery/item/" + NOTE_ID + "/?xsec_token=" + PRIVATE):
            self.assertEqual((await self.call(self.envelope(finalUrl=url)))[0], 200)

    async def test_utf8_html_limit_is_independent_of_json_envelope(self):
        page = self.page()
        available = api.MAX_HTML_BYTES - len(page.encode())
        boundary = page + "汉" * (available // 3) + " " * (available % 3)
        self.assertEqual(len(boundary.encode()), api.MAX_HTML_BYTES)
        self.assertEqual((await self.call(self.envelope(html=boundary)))[0], 200)
        with patch.object(api, "parse_note_html", side_effect=AssertionError("Oversized HTML entered parser")):
            self.assertEqual((await self.call(self.envelope(html=boundary + "x")))[0], 413)

    async def test_envelope_cap_drains_stream_even_with_false_content_length(self):
        with patch.object(api, "parse_note_html", side_effect=AssertionError("Oversized envelope entered parser")):
            status, _, _, request, _ = await self.call(b"x" * (api.MAX_RENDERED_REQUEST_BYTES + 1), headers={"Content-Length": "1"})
        self.assertEqual(status, 413)
        self.assertTrue(request.body.finished)
        self.assertTrue(request.body.released)
        self.assertFalse(request.body.cancelled)

    async def test_invalid_json_utf8_and_surrogates_fail_safely(self):
        for raw in (b"", b"{", b"\xff", json.dumps(self.envelope(html="\ud800")).encode()):
            self.assertEqual((await self.call(raw))[0], 400)

    async def test_private_method_guard_and_exact_route_do_not_add_aliases(self):
        for method in ("GET", "HEAD", "PUT", "OPTIONS"):
            self.assertEqual((await self.call(self.envelope(), method=method))[0], 405)
        for path in (api.RENDERED_NOTE_PATH + "/", "/api/parse-rendered-note", "/api/rendered-note",
                     "/__internal/parse_rendered_note", "/__internal/parse-rendered-note.py"):
            self.assertEqual((await self.call(self.envelope(), path=path))[0], 404)

    async def test_public_parser_cannot_replace_text_with_html_or_expand_body_cap(self):
        self.assertEqual((await self.call(self.envelope(), path="/api/python_parse",
                                         headers={"X-Internal-Rendered": "true", "Cookie": PRIVATE}))[0], 400)
        injected = {"text": "https://ci.xiaohongshu.com/actual/image", **self.envelope()}
        status, body, _, _, _ = await self.call(injected, path="/api/python_parse")
        self.assertEqual(status, 200)
        self.assertEqual(body["images"][0]["token"], "actual/image")
        self.assertEqual(body["videoCount"], 0)
        self.assertEqual((await self.call({"text": NOTE, "html": "x" * api.MAX_REQUEST_BYTES},
                                         path="/api/python_parse"))[0], 413)

    async def test_missing_media_and_internal_errors_do_not_log_private_data(self):
        html = "<title>小红书安全验证</title>PRIVATE_HTML_SENTINEL"
        status, body, logs, _, _ = await self.call(self.envelope(html=html), headers={"Cookie": "PRIVATE_COOKIE_SENTINEL"})
        self.assertEqual(status, 422)
        self.assertIn("要求安全验证", body["message"])
        summary = json.loads(logs.split(" ", 1)[1])
        self.assertEqual(summary["upstream"], [])
        self.assertEqual(summary["failureClass"], "captcha")
        for private in (NOTE_ID, PRIVATE, "PRIVATE_HTML_SENTINEL", "PRIVATE_COOKIE_SENTINEL", "https://"):
            self.assertNotIn(private, logs)
        with patch.object(api, "parse_note_html", side_effect=RuntimeError(PRIVATE)):
            status, body, logs, _, _ = await self.call(self.envelope())
        self.assertEqual(status, 500)
        self.assertNotIn(PRIVATE, logs + json.dumps(body))


if __name__ == "__main__":
    unittest.main(verbosity=2)
