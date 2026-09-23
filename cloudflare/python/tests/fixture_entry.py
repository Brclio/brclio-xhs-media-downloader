"""Test-only outbound fixtures; copied into an isolated workerd test project."""

import json
from urllib.parse import parse_qs, urlparse

from workers import Response
import entry as api

NOTE_ID = "abcdef1234567890abcdef12"
IMAGE = "https://sns-webpic-qc.xhscdn.com/202609230000/signature/fixtureimage!nd_dft_wlteh_webp_3"
VIDEO = "https://sns-video-bd.xhscdn.com/fixture.mp4"


async def fixture_fetch(url, **options):
    assert options["redirect"] == "manual"
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    scenario = (query.get("case") or ["normal"])[0]
    if parsed.hostname == "xhslink.com":
        target = "https://example.com/private" if scenario == "unsafe" else f"https://www.xiaohongshu.com/explore/{NOTE_ID}"
        return Response(status=302, headers={"Location": target})
    if parsed.hostname == "www.xiaohongshu.com":
        if scenario == "blocked":
            return Response("blocked", status=461)
        if scenario == "empty":
            return Response("")
        if scenario == "large":
            return Response("x" * (api.MAX_HTML_BYTES + 1))
        if scenario == "missing":
            return Response("<title>missing</title>")
        note = {"noteId": NOTE_ID, "title": "测试笔记", "desc": "原始正文", "imageList": [{
            "urlDefault": IMAGE, "livePhoto": True,
            "stream": {"h264": [{"masterUrl": VIDEO, "duration": 2500}]},
        }], "video": {"media": {"stream": {"h264": [{"masterUrl": VIDEO,
            "audioChannels": 2, "audioCodec": "aac", "width": 1080, "height": 1920}]}}}}
        return Response("<script>window.__INITIAL_STATE__=" + json.dumps({"note": {"noteDetailMap": {NOTE_ID: {"note": note}}}}) + ";</script>")
    if parsed.hostname == "ci.xiaohongshu.com":
        if "redirect" in parsed.path:
            return Response(status=302, headers={"Location": "https://example.com/private"})
        if "html" in parsed.path:
            return Response("no image", headers={"Content-Type": "text/html"})
        if "large" in parsed.path:
            return Response(b"x" * (api.MAX_IMAGE_BYTES + 1), headers={"Content-Type": "image/jpeg"})
        return Response(b"\xff\xd8image\xff\xd9", headers={"Content-Type": "image/jpeg"})
    if parsed.hostname == "sns-video-bd.xhscdn.com":
        if scenario == "unsafe":
            return Response(status=302, headers={"Location": "https://example.com/private"})
        if scenario == "no-range":
            return Response(b"abcdef", headers={"Content-Type": "video/mp4"})
        start, end = map(int, options["headers"]["Range"].removeprefix("bytes=").split("-"))
        total = 600_000_000 if scenario == "large" else 6
        reported_end = end + 1 if scenario == "mismatch" else end
        body = b"abcdef"[start:end + 1]
        if scenario == "truncated":
            body = body[:-1]
        return Response(body, status=206, headers={"Content-Type": "video/mp4",
            "Content-Range": f"bytes {start}-{reported_end}/{total}"})
    raise AssertionError("Unexpected outbound request: URL allowlist was bypassed")


api.fetch = fixture_fetch


class Default(api.Default):
    pass
