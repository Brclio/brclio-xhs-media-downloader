"""Independent Python parsing and media API, exposed only by a service binding.

The pure parser is generated from api/python_parse.py. Network I/O is native
Workers fetch; every redirect is validated before it is followed.
"""

from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, urljoin, urlparse

from js import AbortSignal
from workers import Request, Response, WorkerEntrypoint, fetch

from parser_core import (
    MAX_HTML_BYTES, MAX_INPUT_LENGTH, PAGE_HEADERS, XhsError,
    build_no_watermark_url, extract_input_url, extract_note_id,
    extract_original_asset_token, is_allowed_page_url, is_direct_image_url,
    is_xhs_image_url, is_xhs_video_url, normalize_image_url, parse_note_html,
    validate_asset_token,
)

MAX_REQUEST_BYTES = 16 * 1024
MAX_IMAGE_BYTES = 4_200_000
MAX_CHUNK_BYTES = 3_500_000
MAX_VIDEO_BYTES = 512 * 1024 * 1024
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
BASE_HEADERS = {"X-Content-Type-Options": "nosniff", "X-XHS-Engine": "python"}


def json_response(status: int, payload: dict) -> Response:
    return Response(
        json.dumps(payload, ensure_ascii=False), status=status,
        headers={**BASE_HEADERS, "Content-Type": "application/json; charset=utf-8",
                 "Cache-Control": "private, no-store"},
    )


async def discard_body(response) -> None:
    if response.body is not None:
        await response.body.cancel()


async def read_limited(response, limit: int, message: str) -> bytes:
    """Enforce the limit while reading, including absent/false Content-Length."""
    incoming = isinstance(response, Request)
    declared = response.headers.get("Content-Length", "")
    if not incoming and declared.isdigit() and int(declared) > limit:
        await discard_body(response)
        raise XhsError(message, 413)
    if response.body is None:
        return b""
    reader = response.body.getReader()
    chunks = []
    size = 0
    finished = False
    try:
        while True:
            result = await reader.read()
            if result.done:
                finished = True
                break
            chunk = result.value.to_bytes()
            size += len(chunk)
            if size > limit:
                if not incoming:
                    raise XhsError(message, 413)
                # Drain incoming request bytes without retaining them. Aborting
                # an unread Request can tear down the service-binding transport.
                chunks.clear()
            else:
                chunks.append(chunk)
    finally:
        if not finished and not incoming:
            await reader.cancel()
        reader.releaseLock()
    if size > limit:
        raise XhsError(message, 413)
    return b"".join(chunks)


async def safe_fetch(url: str, *, headers: dict, validator, label: str,
                     timeout_ms: int = 15000):
    signal = AbortSignal.timeout(timeout_ms)
    for hop in range(6):
        if not validator(url):
            raise XhsError(f"{label}跳转到了不受支持的地址。", 502)
        response = await fetch(url, method="GET", headers=headers,
                               redirect="manual", signal=signal)
        if response.status not in REDIRECT_STATUSES:
            return response, url
        location = response.headers.get("Location", "")
        await discard_body(response)
        if not location or hop == 5:
            raise XhsError(f"{label}跳转次数过多或缺少目标地址。", 502)
        url = urljoin(url, location)
    raise XhsError(f"{label}跳转次数过多。", 502)


async def fetch_note_page(input_url: str) -> tuple[str, str]:
    if not is_allowed_page_url(input_url):
        raise XhsError("分享链接地址不受支持。")
    try:
        response, final_url = await safe_fetch(
            input_url, headers=PAGE_HEADERS, validator=is_allowed_page_url,
            label="分享链接",
        )
        if not 200 <= response.status < 300:
            status = response.status
            await discard_body(response)
            if status in (403, 461):
                raise XhsError("小红书拒绝了 Python 服务器访问，可能触发了风控，请切换 Node.js 或稍后重试。")
            raise XhsError(f"小红书页面返回 HTTP {status}。", 502 if status >= 500 else 400)
        raw = await read_limited(response, MAX_HTML_BYTES, "页面内容过大，已停止解析。")
        charset = response.headers.get_content_charset() or "utf-8"
        try:
            page_html = raw.decode(charset, errors="replace")
        except LookupError:
            page_html = raw.decode("utf-8", errors="replace")
    except XhsError:
        raise
    except Exception as error:
        raise XhsError("访问小红书页面失败，请稍后重试。", 502) from error
    if not page_html.strip():
        raise XhsError("小红书页面返回内容为空。", 502)
    return final_url, page_html


def media_fields(media: dict, *, video: bool = False) -> dict:
    values = {
        "url": media.get("url", ""), "backupUrls": media.get("backupUrls", []),
        "codec": media.get("codec", ""), "width": media.get("width", 0),
        "height": media.get("height", 0), "bitrate": media.get("bitrate", 0),
        "size": media.get("size", 0), "qualityType": media.get("qualityType", ""),
    }
    if video:
        values.update({"hasAudio": media.get("hasAudio"),
                       "audioCodec": media.get("audioCodec", ""),
                       "audioChannels": media.get("audioChannels", 0),
                       "audioBitrate": media.get("audioBitrate", 0),
                       "label": media.get("label", ""),
                       "isDefault": bool(media.get("isDefault"))})
    else:
        values["duration"] = media.get("duration", 0)
    return values


async def parse_request(request) -> Response:
    raw = await read_limited(request, MAX_REQUEST_BYTES, "请求内容过大。")
    if not raw:
        raise XhsError("请求内容为空。")
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise XhsError("请求 JSON 格式无效。") from error
    raw_text = str(body.get("text", "")).strip() if isinstance(body, dict) else ""
    if not raw_text:
        raise XhsError("请粘贴小红书分享文案或链接。")
    if len(raw_text) > MAX_INPUT_LENGTH:
        raise XhsError("输入内容过长。", 413)
    input_url = extract_input_url(raw_text)
    if is_direct_image_url(input_url):
        token = extract_original_asset_token(input_url)
        if not token or not validate_asset_token(token):
            raise XhsError("无法从图片地址中提取原始资源标识。")
        return json_response(200, {
            "success": True, "engine": "python", "title": "小红书图片",
            "content": "", "type": "image", "count": 1, "livePhotoCount": 0,
            "videoCount": 0, "images": [{"index": 1, "token": token,
                "url": build_no_watermark_url(token), "livePhoto": False, "liveVideo": None}],
            "videos": [],
        })
    final_url, page_html = await fetch_note_page(input_url)
    note_id = extract_note_id(final_url) or extract_note_id(input_url)
    if not note_id:
        raise XhsError("无法从分享链接中识别当前笔记 ID。", 422)
    parsed = parse_note_html(page_html, note_id)
    if not parsed["images"] and not parsed["videos"]:
        raise XhsError("没有解析到图片或视频。笔记可能已删除、需要登录，或者小红书页面结构已更新。", 422)
    images = [{"index": index, "token": item["token"], "url": item["url"],
               "livePhoto": bool(item.get("livePhoto")),
               "liveVideo": media_fields(item["liveVideo"])
               if isinstance(item.get("liveVideo"), dict) else None}
              for index, item in enumerate(parsed["images"], start=1)]
    videos = [{"index": index, **media_fields(item, video=True)}
              for index, item in enumerate(parsed["videos"], start=1)]
    return json_response(200, {
        "success": True, "engine": "python", "title": parsed["title"],
        "content": parsed["content"], "noteId": note_id, "strategy": parsed["strategy"],
        "type": "mixed" if images and videos else "video" if videos else "image",
        "count": len(images), "livePhotoCount": sum(bool(item["liveVideo"]) for item in images),
        "videoCount": len(videos), "images": images, "videos": videos,
    })


def safe_filename(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "image.jpg"))[:80] or "image.jpg"


async def image_request(query: dict) -> Response:
    token = (query.get("token") or [""])[0]
    filename = safe_filename((query.get("name") or ["image.jpg"])[0])
    if not validate_asset_token(token):
        raise XhsError("图片资源标识无效。")
    try:
        response, _ = await safe_fetch(
            build_no_watermark_url(token), validator=is_xhs_image_url, label="原图 CDN",
            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.xiaohongshu.com/",
                     "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"},
        )
        if not 200 <= response.status < 300:
            await discard_body(response)
            raise XhsError(f"原图服务器返回 HTTP {response.status}。", 502)
        content_type = response.headers.get("Content-Type", "image/jpeg").split(";", 1)[0].strip().lower()
        if not content_type.startswith("image/") and content_type != "application/octet-stream":
            await discard_body(response)
            raise XhsError("原图服务器返回的不是图片。", 502)
        body = await read_limited(response, MAX_IMAGE_BYTES, "原图超过单次响应限制，请使用原图直链下载。")
    except XhsError:
        raise
    except Exception as error:
        raise XhsError("下载原图失败，请稍后重试。", 502) from error
    return Response(body, headers={
        **BASE_HEADERS, "Content-Type": "image/jpeg" if content_type == "application/octet-stream" else content_type,
        "Content-Length": str(len(body)), "Content-Disposition": f'attachment; filename="{filename}"',
        "Cache-Control": "private, max-age=300",
    })


def nonnegative_integer(value: str, name: str) -> int:
    if not re.fullmatch(r"[0-9]+", str(value or "")):
        raise XhsError(f"{name} 参数无效。")
    return int(value)


def parse_content_range(value: str | None) -> dict | None:
    match = re.fullmatch(r"bytes\s+(\d+)-(\d+)/(\d+|\*)", str(value or ""), re.I)
    if not match:
        return None
    return {"start": int(match[1]), "end": int(match[2]),
            "total": 0 if match[3] == "*" else int(match[3])}


async def open_video(url: str, range_header: str):
    try:
        response, _ = await safe_fetch(url, validator=is_xhs_video_url, label="视频 CDN",
            timeout_ms=18000, headers={"User-Agent": "Mozilla/5.0",
                "Accept": "video/mp4,video/*;q=0.9,*/*;q=0.8",
                "Referer": "https://www.xiaohongshu.com/", "Range": range_header})
    except XhsError:
        raise
    except Exception as error:
        raise XhsError("读取视频失败，请稍后重试。", 502) from error
    if response.status not in (200, 206):
        await discard_body(response)
        raise XhsError(f"视频服务器返回 HTTP {response.status}。", 502)
    return response


async def video_request(query: dict) -> Response:
    source_url = normalize_image_url((query.get("url") or [""])[0])
    action = (query.get("action") or ["meta"])[0]
    if not is_xhs_video_url(source_url):
        raise XhsError("视频地址无效或不属于小红书 CDN。")
    if action == "meta":
        response = await open_video(source_url, "bytes=0-0")
        content_range = parse_content_range(response.headers.get("Content-Range"))
        raw_length = response.headers.get("Content-Length", "0")
        content_length = int(raw_length) if raw_length.isdigit() else 0
        size = (content_range["total"] if content_range and content_range["total"]
                else content_length if response.status == 200 else 0)
        content_type = response.headers.get("Content-Type", "video/mp4").split(";", 1)[0]
        accept_ranges = response.status == 206 or response.headers.get("Accept-Ranges", "").lower() == "bytes"
        await discard_body(response)
        if size > MAX_VIDEO_BYTES:
            raise XhsError("视频超过 512 MB，浏览器本地合并可能占用过多内存。", 413)
        return json_response(200, {"success": True, "engine": "python", "size": size,
            "contentType": content_type, "acceptRanges": accept_ranges, "chunkSize": MAX_CHUNK_BYTES})
    if action != "chunk":
        raise XhsError("不支持的视频操作。")
    start = nonnegative_integer((query.get("start") or [""])[0], "start")
    end = nonnegative_integer((query.get("end") or [""])[0], "end")
    if end < start:
        raise XhsError("视频分段范围无效。")
    if end - start + 1 > MAX_CHUNK_BYTES:
        raise XhsError(f"单个视频分段不能超过 {MAX_CHUNK_BYTES} 字节。", 413)
    response = await open_video(source_url, f"bytes={start}-{end}")
    try:
        raw_length = response.headers.get("Content-Length", "0")
        declared = int(raw_length) if raw_length.isdigit() else 0
        if response.status == 200 and (start > 0 or declared > MAX_CHUNK_BYTES):
            raise XhsError("视频源不支持 Range 分段下载，请使用“打开视频”。", 409)
        content_range = parse_content_range(response.headers.get("Content-Range"))
        if response.status == 206 and (not content_range or content_range["start"] != start
                or content_range["end"] != end or content_range["total"] <= end):
            raise XhsError("视频服务器返回了不匹配的分段范围，已停止合并。", 502)
    except XhsError:
        await discard_body(response)
        raise
    body = await read_limited(response, MAX_CHUNK_BYTES, "视频分段超过服务器单次响应限制。")
    if len(body) != end - start + 1:
        raise XhsError("视频分段不完整，已停止合并。", 502)
    headers = {**BASE_HEADERS, "Content-Type": response.headers.get("Content-Type", "application/octet-stream").split(";", 1)[0],
        "Content-Length": str(len(body)), "Accept-Ranges": "bytes", "Cache-Control": "private, no-store"}
    if content_range:
        headers["Content-Range"] = f'bytes {content_range["start"]}-{content_range["end"]}/{content_range["total"] or "*"}'
        if content_range["total"]:
            headers["X-Video-Total"] = str(content_range["total"])
    return Response(body, headers=headers)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        request = request if isinstance(request, Request) else Request(request)
        path = urlparse(request.url).path.rstrip("/")
        operation = path.rsplit("/", 1)[-1].replace("_", "-")
        operation = operation.removesuffix(".py")
        if operation not in {"python-parse", "python-image", "python-video"}:
            return json_response(404, {"success": False, "message": "接口不存在。"})
        method = "POST" if operation == "python-parse" else "GET"
        if request.method == "OPTIONS":
            return Response(status=204, headers={**BASE_HEADERS, "Allow": f"{method}, OPTIONS"})
        if request.method != method:
            return json_response(405, {"success": False, "message": f"只支持 {method} 请求。"})
        try:
            if operation == "python-parse":
                return await parse_request(request)
            query = parse_qs(urlparse(request.url).query)
            return await (image_request(query) if operation == "python-image" else video_request(query))
        except XhsError as error:
            payload = {"success": False, "message": str(error)}
            if operation == "python-parse":
                payload["engine"] = "python"
            return json_response(error.status_code, payload)
        except Exception as error:
            # Do not log note URLs, headers, or user input.
            print("Python Worker error", operation, type(error).__name__)
            message = {"python-parse": "Python 服务器解析失败，请切换 Node.js 或稍后重试。",
                       "python-image": "Python 图片下载失败。", "python-video": "Python 视频下载失败。"}[operation]
            return json_response(500, {"success": False, "engine": "python", "message": message})
