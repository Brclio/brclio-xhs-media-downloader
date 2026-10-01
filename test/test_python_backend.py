from __future__ import annotations

import importlib.util
import io
import json
import re
import unittest
from pathlib import Path
from email.message import Message
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "api" / "python_parse.py"
SPEC = importlib.util.spec_from_file_location("python_parse", MODULE_PATH)
assert SPEC and SPEC.loader
python_parse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(python_parse)

WORKER_SPEC = importlib.util.spec_from_file_location("worker_parser", ROOT / "cloudflare/python/src/parser_core.py")
assert WORKER_SPEC and WORKER_SPEC.loader
worker_parser = importlib.util.module_from_spec(WORKER_SPEC)
WORKER_SPEC.loader.exec_module(worker_parser)

VIDEO_MODULE_PATH = ROOT / "api" / "python_video.py"
VIDEO_SPEC = importlib.util.spec_from_file_location("python_video", VIDEO_MODULE_PATH)
assert VIDEO_SPEC and VIDEO_SPEC.loader
python_video = importlib.util.module_from_spec(VIDEO_SPEC)
VIDEO_SPEC.loader.exec_module(python_video)


def image_url(identifier: str, variant: str = "!nd_dft_wlteh_webp_3") -> str:
    return (
        "https://sns-webpic-qc.xhscdn.com/"
        f"202607301856/signature/{identifier}{variant}"
    )


def make_image_list(prefix: str, count: int) -> list[dict[str, str]]:
    return [
        {
            "urlDefault": image_url(f"{prefix}{index:02d}"),
            "urlPre": image_url(
                f"{prefix}{index:02d}",
                "!nd_prv_wlteh_webp_3",
            ),
        }
        for index in range(1, count + 1)
    ]


def live_photo_video_url(host: str, identifier: str) -> str:
    return f"http://{host}/stream/{identifier}.mp4"


def make_live_photo_image(
    identifier: str,
    *,
    live_photo: bool | None = True,
    stream: bool = True,
    stream_key: str = "h264",
    stream_field: str = "stream",
) -> dict[str, object]:
    image: dict[str, object] = {
        "urlDefault": image_url(identifier),
        "urlPre": image_url(identifier, "!nd_prv_wlteh_webp_3"),
    }
    if live_photo is not None:
        image["livePhoto"] = live_photo
    if stream:
        image[stream_field] = {
            stream_key: [
                {
                    "masterUrl": live_photo_video_url(
                        "sns-video-zl.xhscdn.com", identifier
                    ),
                    "backupUrls": [
                        live_photo_video_url(
                            "sns-bak-v8.xhscdn.com", identifier
                        ),
                        live_photo_video_url(
                            "sns-bak-v10.xhscdn.com", identifier
                        ),
                    ],
                    "videoCodec": stream_key,
                    "width": 1080,
                    "height": 1920,
                    "videoBitrate": 2_300_000,
                    "size": 800_000,
                    "duration": 2800,
                    "videoDuration": 2750,
                    "qualityType": "HD",
                }
            ]
        }
    return image


class PythonBackendTests(unittest.TestCase):
    def test_public_parse_hides_undeclared_protected_paths_and_preserves_safe_backup_or_explicit_origin_only(self) -> None:
        note_id = "abcdef1234567890abcdef12"
        protected = "https://sns-video-bd.xhscdn.com/spectrum/undeclared-upload"
        safe = "https://sns-video-bd.xhscdn.com/stream/ordinary.mp4"
        def call(note):
            html = '<script>window.__INITIAL_STATE__=' + json.dumps({"noteData": {"data": note}}) + '</script>'
            body = json.dumps({"text": f"https://www.xiaohongshu.com/explore/{note_id}"}).encode()
            request = object.__new__(python_parse.handler)
            request.headers = {"Content-Length": str(len(body))}; request.rfile = io.BytesIO(body)
            captured = {}
            request._send_json = lambda status, payload: captured.update(status=status, payload=payload)
            with patch.object(python_parse, "fetch_note_page", return_value=(f"https://www.xiaohongshu.com/explore/{note_id}", html)):
                request.do_POST()
            return captured, html
        note = {"noteId": note_id, "video": {"media": {"stream": {"h264": [{"masterUrl": protected, "backupUrls": [safe, protected]}]}}},
                "imageList": [{"urlDefault": image_url("live"), "livePhoto": True, "stream": {"h264": [{"masterUrl": protected, "backupUrls": [safe, protected]}]}},
                              {"urlDefault": image_url("still"), "livePhoto": True, "stream": {"h264": [{"masterUrl": protected}]}}]}
        captured, html = call(note)
        self.assertEqual(python_parse.parse_note_html(html, note_id)["videos"][0]["url"], protected)
        self.assertEqual(captured["status"], 200)
        data = captured["payload"]
        self.assertEqual(data["videos"][0]["url"], safe)
        self.assertEqual(data["videos"][0]["backupUrls"], [])
        self.assertTrue(data["videos"][0]["isDefault"])
        self.assertEqual(data["images"][0]["liveVideo"]["url"], safe)
        self.assertIsNone(data["images"][1]["liveVideo"])
        self.assertEqual(data["livePhotoCount"], 1)
        self.assertFalse(data["hasOriginalVideo"])
        self.assertEqual(data["originalVideoCount"], 0)
        self.assertNotIn(protected, json.dumps(data))
        for parser in (python_parse, worker_parser):
            self.assertEqual(parser.public_playback_video({"url": protected, "backupUrls": [safe, protected]})["url"], safe)
            self.assertIsNone(parser.public_playback_video({"url": protected}))
        note = {"noteId": note_id, "video": {"media": {"stream": {"h264": [{"masterUrl": protected}]}}}}
        self.assertEqual(call(note)[0]["status"], 422)
        note["video"]["consumer"] = {"originVideoKey": "spectrum/undeclared-upload"}
        captured, _ = call(note)
        self.assertEqual(captured["status"], 200)
        self.assertTrue(captured["payload"]["hasOriginalVideo"])
        self.assertEqual(captured["payload"]["videos"], [])
        self.assertNotIn(protected, json.dumps(captured["payload"]))

    def test_audio_stream_preference_and_original_isolation(self) -> None:
        streams = python_parse.extract_video_streams_from_note({"video": {
            "consumer": {"originVideoKey": "original.mp4"},
            "media": {"stream": {
                "h264": [{"masterUrl": "https://sns-video-bd.xhscdn.com/silent.mp4", "audioChannels": 0, "audioCodec": "", "width": 3840, "height": 2160}],
                "h265": [{"masterUrl": "https://sns-video-bd.xhscdn.com/audio.mp4", "audioChannels": 2, "audioCodec": "aac", "width": 720, "height": 1280}],
            }},
        }})
        streams = python_parse.prepare_video_results(streams)
        self.assertTrue(streams[0]["hasAudio"])
        self.assertEqual(streams[0]["audioCodec"], "aac")
        self.assertTrue(streams[0]["url"].endswith("/audio.mp4"))
        self.assertFalse(streams[-1]["hasAudio"])
        self.assertFalse(any(s["source"] == "origin-video-key" for s in streams))
        originals = python_parse.extract_original_videos_from_note({"video": {"consumer": {"originVideoKey": "original.mp4"}}})
        self.assertEqual(originals[0]["source"], "origin-video-key")
        self.assertEqual(originals[0]["sourceWatermark"], "unknown")

    def test_original_sources_are_exact_note_bound_and_do_not_leak_into_playback(self) -> None:
        note_id = "dddddddddddddddddddddddd"
        original = "https://sns-video-bd.xhscdn.com/spectrum/explicit-original.mp4?sign=fixture&t=123"
        ordinary = "https://sns-video-bd.xhscdn.com/stream/ordinary.mp4"
        note = {"noteId": note_id, "video": {
            "consumer": {"originVideoKey": original},
            "media": {"stream": {"h264": [{"masterUrl": original, "backupUrls": [ordinary]},
                {"masterUrl": ordinary, "backupUrls": [original]}]}},
        }, "imageList": [{"urlDefault": image_url("cover"), "stream": {"h264": [{"masterUrl": original}]}}]}
        html = "<script>window.__INITIAL_STATE__=" + json.dumps({"noteData": {"data": note},
            "recommendations": [{"noteId": "aaaaaaaaaaaaaaaaaaaaaaaa", "video": {"consumer": {"originVideoKey": "unrelated.mp4"}}}]}) + "</script>"
        for parser in (python_parse, worker_parser):
            with self.subTest(parser=parser.__name__):
                parsed = parser.parse_note_html(html, note_id)
                self.assertEqual(len(parsed["originalVideos"]), 1)
                source = parsed["originalVideos"][0]
                self.assertEqual(source["url"], original)
                self.assertEqual(source["sourceField"], "video.consumer.originVideoKey")
                self.assertEqual(source["sourceWatermark"], "unknown")
                self.assertIsNone(source["hasAudio"])
                self.assertEqual(source["codec"], "")
                self.assertTrue(all(original not in [v["url"], *v["backupUrls"]] for v in parsed["videos"]))
                self.assertIsNone(parsed["images"][0]["liveVideo"])

    def test_original_only_local_notes_and_unsafe_original_field_rejection(self) -> None:
        note_id = "dddddddddddddddddddddddd"
        for parser in (python_parse, worker_parser):
            for video in ({"consumer": {"origin_video_key": "spectrum/source"}},
                          {"originVideoKey": "//sns-video-bd.xhscdn.com/spectrum/source"},
                          {"origin_video_key": "/spectrum/source"}):
                note = {"noteId": note_id, "video": video}
                for html in ("<script>window.__INITIAL_STATE__=" + json.dumps({"noteData": {"data": note}}) + "</script>",
                             '<script>window.__INITIAL_STATE__={"broken":function(){},"detail":' + json.dumps(note) + "}</script>"):
                    parsed = parser.parse_note_html(html, note_id)
                    self.assertEqual(parsed["originalVideos"][0]["url"], "https://sns-video-bd.xhscdn.com/spectrum/source")
                    self.assertEqual(parsed["videos"], [])
            for key in ("https://evil.example/a", "https://user:secret@sns-video-bd.xhscdn.com/a",
                        "https://sns-video-bd.xhscdn.com:8443/a", "http://sns-video-bd.xhscdn.com/a",
                        "../a", "a/../b", "javascript:alert(1)", "spectrum/a?url=evil", "spectrum/with space"):
                with self.subTest(parser=parser.__name__, key=key):
                    self.assertEqual(parser.extract_original_videos_from_note({"video": {"consumer": {"originVideoKey": key}}}), [])

    def test_public_python_parse_advertises_original_count_without_source_urls(self) -> None:
        note_id = "dddddddddddddddddddddddd"
        html = '<script>window.__INITIAL_STATE__=' + json.dumps({"noteData": {"data": {
            "noteId": note_id, "video": {"consumer": {"originVideoKey": "spectrum/member-source"}}
        }}}) + '</script>'
        body = json.dumps({"text": f"https://www.xiaohongshu.com/explore/{note_id}"}).encode()
        request = object.__new__(python_parse.handler)
        request.headers = {"Content-Length": str(len(body))}
        request.rfile = io.BytesIO(body)
        captured = {}
        request._send_json = lambda status, payload: captured.update(status=status, payload=payload)
        with patch.object(python_parse, "fetch_note_page", return_value=(f"https://www.xiaohongshu.com/explore/{note_id}", html)):
            request.do_POST()
        self.assertEqual(captured["status"], 200)
        self.assertEqual(captured["payload"]["originalVideoCount"], 1)
        self.assertTrue(captured["payload"]["hasOriginalVideo"])
        self.assertEqual(captured["payload"]["type"], "video")
        self.assertEqual(captured["payload"]["videos"], [])
        self.assertNotIn("member-source", json.dumps(captured["payload"]))
        self.assertNotIn("originalVideos", captured["payload"])

    def test_media_v2_metadata_describes_upload_without_claiming_codec_audio_or_watermark(self) -> None:
        metadata = {"video": {"width": 1920, "height": 1080, "duration": 469,
                              "md5": "3d8c06fa6cb6a8c5524548b3be0d2db4"},
                    "stream": {"h264": [{"width": 1280, "height": 720, "audio_codec": "aac"}]}}
        for parser in (python_parse, worker_parser):
            for media_v2 in (metadata, json.dumps(metadata)):
                source = parser.extract_original_videos_from_note({"video": {
                    "consumer": {"originVideoKey": "spectrum/current-upload"}, "mediaV2": media_v2
                }})[0]
                self.assertEqual(source["width"], 1920)
                self.assertEqual(source["height"], 1080)
                self.assertEqual(source["duration"], 469000)
                self.assertEqual(source["declaredMd5"], metadata["video"]["md5"])
                self.assertEqual(source["metadataSource"], "video.mediaV2.video")
                self.assertEqual(source["codec"], "")
                self.assertIsNone(source["hasAudio"])
                self.assertEqual(source["sourceWatermark"], "unknown")
            for media_v2 in ('{BROKEN', {"video": {"md5": [metadata["video"]["md5"]]}}):
                source = parser.extract_original_videos_from_note({"video": {
                    "consumer": {"originVideoKey": "spectrum/current-upload"}, "mediaV2": media_v2
                }})[0]
                self.assertEqual(source["declaredMd5"], "")

    def test_ambiguous_stream_origins_are_rejected_without_ordinary_or_meta_leaks(self) -> None:
        note_id = "dddddddddddddddddddddddd"
        for parser in (python_parse, worker_parser):
            for key in ("stream/ambiguous.mp4", "/stream/ambiguous.mp4",
                        "https://sns-video-bd.xhscdn.com/stream/ambiguous.mp4",
                        "https://sns-video-bd.xhscdn.com/%73tream/ambiguous.mp4"):
                url = key if key.startswith("https:") else "https://sns-video-bd.xhscdn.com/" + key.lstrip("/")
                note = {"noteId": note_id, "video": {"consumer": {"originVideoKey": key},
                        "media": {"stream": {"h264": [{"masterUrl": url, "backupUrls": [url]}]}}}}
                for html in ("<script>window.__INITIAL_STATE__=" + json.dumps({"noteData": {"data": note}}) + "</script>",
                             '<script>window.__INITIAL_STATE__={"broken":function(){},"detail":' + json.dumps(note) + "}</script>"):
                    parsed = parser.parse_note_html(f'<meta property="og:video" content="{url}">' + html, note_id)
                    self.assertEqual(parsed["originalVideos"], [])
                    self.assertEqual(parsed["videos"], [])

    def test_video_chunk_range_and_length_are_verified(self) -> None:
        for content_range, body, status in [
            ("bytes 3-5/10", b"abc", 200), ("bytes 0-2/10", b"abc", 502),
            (None, b"abc", 502), ("bytes 3-5/10", b"ab", 502),
        ]:
            response = io.BytesIO(body)
            response.status = 206
            response.getcode = lambda: 206
            response.headers = Message()
            response.headers["Content-Type"] = "video/mp4"
            if content_range:
                response.headers["Content-Range"] = content_range
            request = object.__new__(python_video.handler)
            request.path = "/api/python_video?url=https%3A%2F%2Fsns-video-bd.xhscdn.com%2Fstream%2Ffixture.mp4&action=chunk&start=3&end=5"
            request.wfile = io.BytesIO()
            request.send_response = lambda value: setattr(request, "status", value)
            request.send_header = lambda *_: None
            request.end_headers = lambda: None
            with patch.object(python_video, "open_video", return_value=response):
                request.do_GET()
            self.assertEqual(request.status, status)
            if status == 200:
                self.assertEqual(request.wfile.getvalue(), body)
            else:
                self.assertFalse(json.loads(request.wfile.getvalue())["success"])

    def test_video_url_port_and_malformed_image_token_safety(self) -> None:
        self.assertFalse(
            python_parse.is_xhs_video_url(
                "https://sns-video-v28.xhscdn.com:8443/stream/live.mp4"
            )
        )
        self.assertTrue(
            python_parse.is_xhs_video_url(
                "https://sns-video-v28.xhscdn.com:443/stream/live.mp4"
            )
        )
        self.assertFalse(
            python_video.is_xhs_video_url(
                "https://sns-video-v28.xhscdn.com:8443/stream/live.mp4"
            )
        )
        self.assertTrue(
            python_video.is_xhs_video_url(
                "https://sns-video-v28.xhscdn.com:443/stream/live.mp4"
            )
        )
        self.assertIsNone(
            python_parse.extract_original_asset_token(
                "https://sns-webpic-qc.xhscdn.com/%E0%A4%A"
            )
        )
        self.assertFalse(
            python_parse.is_xhs_image_url("https://evilxhscdn.com/image.jpg")
        )
        self.assertFalse(
            python_parse.is_direct_image_url(
                "https://user:pass@sns-webpic-qc.xhscdn.com:8443/image.jpg"
            )
        )

    def test_extract_note_id(self) -> None:
        self.assertEqual(
            python_parse.extract_note_id(
                "https://www.xiaohongshu.com/discovery/item/"
                "6a68c6d3000000001303f099?source=webshare"
            ),
            "6a68c6d3000000001303f099",
        )
        self.assertEqual(
            python_parse.extract_note_id(
                "https://www.xiaohongshu.com/explore/1234567890abcdef12345678"
            ),
            "1234567890abcdef12345678",
        )

    def test_mobile_short_link_input_and_host_boundary(self) -> None:
        short_url = "https://xhslink.cn/o/2KYMK6MAHx9"
        desktop_url = (
            "https://www.xiaohongshu.com/discovery/item/"
            "6a657da9000000000f02b94a?source=webshare&xhsshare=pc_web"
            "&xsec_token=desktop-token="
        )
        escaped_desktop_url = re.sub(
            r"([_&=])", r"\\\1", desktop_url
        )
        self.assertEqual(
            python_parse.extract_input_url(
                f"从离职后，我开始做编程私教 {short_url} "
                "直达【小红书】看看这篇分享~"
            ),
            short_url,
        )
        self.assertEqual(
            python_parse.extract_input_url(f"[{short_url}]({short_url})"),
            short_url,
        )
        self.assertEqual(
            python_parse.extract_input_url(
                f"79 【Python一对一教学】 "
                f"[{escaped_desktop_url}]({escaped_desktop_url})"
            ),
            desktop_url,
        )
        self.assertEqual(
            python_parse.extract_input_url(
                f"先忽略 https://example.com/docs 再打开 {short_url}"
            ),
            short_url,
        )
        self.assertTrue(python_parse.is_allowed_page_host("xhslink.cn"))
        self.assertTrue(python_parse.is_allowed_page_host("www.xhslink.cn"))
        self.assertFalse(
            python_parse.is_allowed_page_host("xhslink.cn.example.com")
        )
        with self.assertRaisesRegex(python_parse.XhsError, "只支持小红书分享链接"):
            python_parse.extract_input_url(
                "https://xhslink.cn.example.com/o/fake"
            )
        for unsafe_url in (
            "https://user:password@xhslink.cn/o/fake",
            "https://xhslink.cn:8443/o/fake",
        ):
            with self.assertRaisesRegex(
                python_parse.XhsError,
                "只支持小红书分享链接",
            ):
                python_parse.extract_input_url(unsafe_url)

        self.assertTrue(python_parse.is_allowed_page_url(short_url))
        self.assertFalse(
            python_parse.is_allowed_page_url(
                "http://www.xiaohongshu.com/discovery/item/"
                "668d2967000000002500100a"
            )
        )
        redirect_handler = python_parse.SafeRedirectHandler()
        with self.assertRaisesRegex(
            python_parse.XhsError,
            "跳转到了不受支持的地址",
        ):
            redirect_handler.redirect_request(
                python_parse.Request(short_url),
                None,
                302,
                "Found",
                {},
                "http://www.xiaohongshu.com/discovery/item/"
                "668d2967000000002500100a",
            )

    def test_only_target_note_images(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        other_id = "aaaaaaaaaaaaaaaaaaaaaaaa"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "目标帖子",
                            "desc": "目标正文\r\n第二行 #目标",
                            "imageList": make_image_list("target", 7),
                        }
                    },
                    other_id: {
                        "note": {
                            "noteId": other_id,
                            "title": "相关推荐",
                            "desc": "推荐正文（禁止返回）",
                            "imageList": make_image_list("other", 15),
                        }
                    },
                }
            },
            "recommendations": make_image_list("recommend", 20),
        }
        page_html = (
            "<!doctype html><html><head>"
            f'<meta property="og:image" content="{image_url("cover")}">'
            "</head><body><script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script></body></html>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["strategy"], "exact-initial-state")
        self.assertEqual(parsed["title"], "目标帖子")
        self.assertEqual(parsed["content"], "目标正文\n第二行 #目标")
        self.assertEqual(len(parsed["images"]), 7)
        self.assertTrue(
            all(image["token"].startswith("target") for image in parsed["images"])
        )
        self.assertFalse(
            any(image["token"].startswith("other") for image in parsed["images"])
        )

    def test_live_photos_stay_paired_and_exclude_recommendations(self) -> None:
        target_id = "6a81c37e0000000025016000"
        other_id = "bbbbbbbbbbbbbbbbbbbbbbbb"
        state = {
            "noteData": {
                "data": {
                    "noteData": {
                        "noteId": target_id,
                        "type": "normal",
                        "title": "混合实况帖子",
                        "imageList": [
                            make_image_list("static", 1)[0],
                            make_live_photo_image("live-flagged"),
                            make_live_photo_image(
                                "live-inferred",
                                live_photo=None,
                            ),
                        ],
                    },
                    "relatedNotes": [
                        {
                            "noteId": other_id,
                            "title": "推荐实况帖子",
                            "imageList": [
                                make_live_photo_image("recommend-live")
                            ],
                        }
                    ],
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(parsed["strategy"], "exact-initial-state")
        self.assertEqual(
            [image["token"] for image in parsed["images"]],
            ["static01", "live-flagged", "live-inferred"],
        )
        self.assertEqual(
            [bool(image["livePhoto"]) for image in parsed["images"]],
            [False, True, True],
        )
        self.assertIsNone(parsed["images"][0]["liveVideo"])
        self.assertEqual(
            parsed["images"][1]["liveVideo"]["url"],
            "https://sns-video-zl.xhscdn.com/stream/live-flagged.mp4",
        )
        self.assertEqual(
            parsed["images"][1]["liveVideo"]["backupUrls"],
            [
                "https://sns-bak-v8.xhscdn.com/stream/live-flagged.mp4",
                "https://sns-bak-v10.xhscdn.com/stream/live-flagged.mp4",
            ],
        )
        self.assertEqual(parsed["images"][1]["liveVideo"]["duration"], 2750)
        self.assertNotIn("recommend-live", json.dumps(parsed["images"]))
        self.assertEqual(parsed["videos"], [])

    def test_all_live_photo_codecs_and_stream_aliases(self) -> None:
        target_id = "live-codecs-stream-aliases"
        codecs_and_fields = (
            ("h264", "stream"),
            ("h265", "livePhotoStream"),
            ("h266", "live_photo_stream"),
            ("av1", "stream"),
        )
        image_list = [
            make_live_photo_image(
                f"live-{codec}",
                live_photo=None,
                stream_key=codec,
                stream_field=stream_field,
            )
            for codec, stream_field in codecs_and_fields
        ]
        image_list[1]["stream"] = {}
        h266_root = image_list[2]["live_photo_stream"]
        h266_root["h266"] = h266_root["h266"][0]
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "imageList": image_list,
                        }
                    }
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, separators=(",", ":"))
            + "</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(
            [image["liveVideo"]["codec"] for image in parsed["images"]],
            ["h264", "h265", "h266", "av1"],
        )
        self.assertTrue(all(image["livePhoto"] for image in parsed["images"]))
        self.assertEqual(parsed["videos"], [])

    def test_live_photo_string_flags_are_parsed_strictly(self) -> None:
        self.assertFalse(
            python_parse.is_live_photo_item({"livePhoto": "false"})
        )
        self.assertFalse(
            python_parse.is_live_photo_item({"live_photo": " 0 "})
        )
        self.assertTrue(
            python_parse.is_live_photo_item({"isLivePhoto": " TRUE "})
        )
        self.assertTrue(
            python_parse.is_live_photo_item({"is_live_photo": "1"})
        )

    def test_duplicate_static_image_keeps_each_live_stream(self) -> None:
        target_id = "duplicate-static-live-001"
        first = make_live_photo_image("shared-static-first-live")
        second = make_live_photo_image("second-live")
        second["urlDefault"] = first["urlDefault"]
        second["urlPre"] = first["urlPre"]
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "重复静态图实况帖子",
                            "imageList": [first, second],
                        }
                    }
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(
            [image["token"] for image in parsed["images"]],
            ["shared-static-first-live", "shared-static-first-live"],
        )
        self.assertEqual(
            [image["liveVideo"]["url"] for image in parsed["images"]],
            [
                "https://sns-video-zl.xhscdn.com/stream/"
                "shared-static-first-live.mp4",
                "https://sns-video-zl.xhscdn.com/stream/second-live.mp4",
            ],
        )

    def test_live_photo_flag_without_stream_keeps_only_the_flag(self) -> None:
        target_id = "liveflagwithoutstream0001"
        flagged = make_live_photo_image("flag-only", stream=False)
        flagged["livePhoto"] = False
        flagged["is_live_photo"] = True
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "只有实况标记",
                            "imageList": [flagged],
                        }
                    }
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(len(parsed["images"]), 1)
        self.assertTrue(parsed["images"][0]["livePhoto"])
        self.assertIsNone(parsed["images"][0]["liveVideo"])
        self.assertEqual(parsed["videos"], [])

    def test_live_photo_api_output_includes_pair_metadata(self) -> None:
        target_id = "api-live-photo-00000001"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "API 实况帖子",
                            "imageList": [make_live_photo_image("api-live")],
                        }
                    }
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )
        source_url = (
            "https://www.xiaohongshu.com/discovery/item/" + target_id
        )
        request_body = json.dumps({"text": source_url}).encode("utf-8")
        sent: list[tuple[int, dict[str, object]]] = []
        request_handler = python_parse.handler.__new__(python_parse.handler)
        request_handler.headers = {"Content-Length": str(len(request_body))}
        request_handler.rfile = io.BytesIO(request_body)
        request_handler._send_json = (  # type: ignore[method-assign]
            lambda status_code, payload: sent.append((status_code, payload))
        )

        with patch.object(
            python_parse,
            "fetch_note_page",
            return_value=(source_url, page_html),
        ):
            request_handler.do_POST()

        self.assertEqual(len(sent), 1)
        status_code, payload = sent[0]
        self.assertEqual(status_code, 200)
        self.assertEqual(payload["livePhotoCount"], 1)
        self.assertEqual(payload["videoCount"], 0)
        self.assertEqual(payload["videos"], [])
        image = payload["images"][0]
        self.assertTrue(image["livePhoto"])
        self.assertEqual(image["liveVideo"]["codec"], "h264")
        self.assertEqual(image["liveVideo"]["duration"], 2750)
        self.assertNotIn("source", image["liveVideo"])

    def test_undefined_in_initial_state(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        image_list = json.dumps(make_image_list("undef", 3), separators=(",", ":"))
        page_html = (
            '<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"'
            + target_id
            + '":{"note":{"noteId":"'
            + target_id
            + '","title":"带 undefined","extra":undefined,"imageList":'
            + image_list
            + "}}}}}</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["title"], "带 undefined")
        self.assertEqual(len(parsed["images"]), 3)

    def test_local_fallback_stays_near_target_id(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        target_list = json.dumps(make_image_list("local", 4), separators=(",", ":"))
        other_list = json.dumps(make_image_list("far", 12), separators=(",", ":"))
        page_html = (
            '<meta name="description" content="页面描述也不能作为当前文案">'
            f'<script>{{"noteId":"{target_id}","desc":"局部正文不可猜测",'
            f'BROKEN,"imageList":{target_list}}}</script>'
            + ("x" * 70000)
            + f'<script>{{"noteId":"bbbbbbbbbbbbbbbbbbbbbbbb","imageList":{other_list}}}</script>'
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["strategy"], "note-id-local-image-list")
        self.assertEqual(parsed["content"], "")
        self.assertEqual(len(parsed["images"]), 4)
        self.assertTrue(
            all(image["token"].startswith("local") for image in parsed["images"])
        )

    def test_local_fallback_is_object_bound_and_excludes_live_video_urls(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        target_list = (
            '[{"urlDefault":"'
            + image_url("fallback-static")
            + '"},BROKEN,{"masterUrl":"'
            + live_photo_video_url(
                "sns-video-zl.xhscdn.com", "fallback-live"
            )
            + '"}]'
        )
        recommended_list = json.dumps(
            make_image_list("recommended", 1), separators=(",", ":")
        )
        recommended_video = json.dumps(
            {
                "media": {
                    "stream": {
                        "h264": [
                            {
                                "masterUrl": live_photo_video_url(
                                    "sns-video-zl.xhscdn.com",
                                    "recommended-video",
                                )
                            }
                        ]
                    }
                }
            },
            separators=(",", ":"),
        )
        page_html = (
            f'<script>{{"noteId":"{target_id}","padding":"'
            + ("x" * 1200)
            + f'",BROKEN,"imageList":{target_list}}}</script>'
            + f'<script>{{"trackingCurrentId":"{target_id}",'
            + f'"imageList":{recommended_list},"video":{recommended_video}}}</script>'
        )

        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(parsed["strategy"], "note-id-local-image-list")
        self.assertEqual(
            [image["token"] for image in parsed["images"]],
            ["fallback-static"],
        )
        self.assertIsNone(parsed["images"][0]["liveVideo"])
        self.assertEqual(parsed["videos"], [])

    def test_local_fallback_ignores_nested_recommended_media(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        recommended_list = json.dumps(
            make_image_list("nested-recommended", 1), separators=(",", ":")
        )
        recommended_video = json.dumps(
            {
                "media": {
                    "stream": {
                        "h264": [
                            {
                                "masterUrl": live_photo_video_url(
                                    "sns-video-zl.xhscdn.com",
                                    "nested-recommended-video",
                                )
                            }
                        ]
                    }
                }
            },
            separators=(",", ":"),
        )
        target_list = json.dumps(
            make_image_list("nested-target", 2), separators=(",", ":")
        )
        page_html = (
            f'<script>{{"noteId":"{target_id}","related":'
            f'[{{"imageList":{recommended_list},"video":{recommended_video}}}],'
            '"padding":"'
            + ("x" * 1200)
            + f'",BROKEN,"imageList":{target_list}}}</script>'
        )

        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(parsed["strategy"], "note-id-local-image-list")
        self.assertEqual(len(parsed["images"]), 2)
        self.assertTrue(
            all(
                image["token"].startswith("nested-target")
                for image in parsed["images"]
            )
        )
        self.assertTrue(
            all(
                "recommended" not in image["token"]
                for image in parsed["images"]
            )
        )
        self.assertEqual(parsed["videos"], [])

    def test_no_watermark_conversion(self) -> None:
        source = (
            "https://sns-webpic-qc.xhscdn.com/202607301856/"
            "4660835de850fe69d5c6322b7bb9204c/"
            "0302aq01kizxyauaerw011cracc0u44f1g!nd_dft_wlteh_webp_3"
        )
        token = python_parse.extract_original_asset_token(source)
        self.assertEqual(token, "0302aq01kizxyauaerw011cracc0u44f1g")
        self.assertEqual(
            python_parse.build_no_watermark_url(token),
            "https://ci.xiaohongshu.com/"
            "0302aq01kizxyauaerw011cracc0u44f1g?imageView2/format/jpg",
        )


    def test_only_target_note_video(self) -> None:
        target_id = "6a68c6d3000000001303f099"
        other_id = "bbbbbbbbbbbbbbbbbbbbbbbb"

        def video_url(identifier: str) -> str:
            return f"https://sns-video-bd.xhscdn.com/stream/{identifier}.mp4"

        def stream(identifier: str, width: int, height: int) -> dict[str, object]:
            return {
                "masterUrl": video_url(identifier),
                "backupUrls": [video_url(identifier + "-backup")],
                "videoCodec": "h264",
                "width": width,
                "height": height,
                "videoBitrate": 4_000_000,
                "size": 12_000_000,
            }

        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "目标视频",
                            "desc": "目标视频正文",
                            "type": "video",
                            "imageList": make_image_list("video-cover", 1),
                            "video": {
                                "media": {
                                    "stream": {
                                        "h264": [
                                            stream("target-1080", 1920, 1080),
                                            stream("target-720", 1280, 720),
                                        ]
                                    }
                                }
                            },
                        }
                    },
                    other_id: {
                        "note": {
                            "noteId": other_id,
                            "title": "推荐视频",
                            "desc": "推荐视频正文（禁止返回）",
                            "video": {
                                "media": {
                                    "stream": {
                                        "h264": [stream("other-video", 3840, 2160)]
                                    }
                                }
                            },
                        }
                    },
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )
        parsed = python_parse.parse_note_html(page_html, target_id)

        self.assertEqual(parsed["strategy"], "exact-initial-state")
        self.assertEqual(parsed["title"], "目标视频")
        self.assertEqual(parsed["content"], "目标视频正文")
        self.assertEqual(len(parsed["images"]), 1)
        self.assertEqual(len(parsed["videos"]), 2)
        self.assertTrue(
            all("target-" in video["url"] for video in parsed["videos"])
        )
        self.assertFalse(
            any("other-video" in video["url"] for video in parsed["videos"])
        )
        self.assertEqual(len(parsed["videos"][0]["backupUrls"]), 1)

    def test_video_only_note_without_image_list(self) -> None:
        target_id = "cccccccccccccccccccccccc"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "纯视频",
                            "type": "video",
                            "video": {
                                "media": {
                                    "stream": {
                                        "h264": [
                                            {
                                                "masterUrl": (
                                                    "https://sns-video-bd.xhscdn.com/"
                                                    "stream/video-only.mp4"
                                                ),
                                                "videoCodec": "h264",
                                                "width": 1080,
                                                "height": 1920,
                                                "size": 10_000_000,
                                            }
                                        ]
                                    }
                                }
                            },
                        }
                    }
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, separators=(",", ":"))
            + "</script>"
        )
        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["images"], [])
        self.assertEqual(len(parsed["videos"]), 1)
        self.assertIn("video-only", parsed["videos"][0]["url"])

    def test_missing_target_content_does_not_use_recommendations(self) -> None:
        target_id = "dddddddddddddddddddddddd"
        other_id = "eeeeeeeeeeeeeeeeeeeeeeee"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "无正文目标帖",
                            "imageList": make_image_list("no-desc", 1),
                        }
                    },
                    other_id: {
                        "note": {
                            "noteId": other_id,
                            "desc": "推荐正文（禁止返回）",
                            "imageList": make_image_list("recommended-desc", 10),
                        }
                    },
                }
            }
        }
        page_html = (
            '<meta name="description" content="页面描述（禁止返回）">'
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(parsed["strategy"], "exact-initial-state")
        self.assertEqual(parsed["content"], "")

    def test_content_unicode_limit_and_description_alias(self) -> None:
        target_id = "ffffffffffffffffffffffff"
        state = {
            "note": {
                "noteDetailMap": {
                    target_id: {
                        "note": {
                            "noteId": target_id,
                            "title": "Unicode 文案",
                            "desc": "   ",
                            "description": "  " + ("😀" * 10001) + "  ",
                            "imageList": make_image_list("unicode", 1),
                        }
                    }
                }
            }
        }
        page_html = (
            "<script>window.__INITIAL_STATE__="
            + json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            + "</script>"
        )

        parsed = python_parse.parse_note_html(page_html, target_id)
        self.assertEqual(len(parsed["content"]), 10000)
        self.assertTrue(parsed["content"].endswith("😀"))



if __name__ == "__main__":
    unittest.main()
