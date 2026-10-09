"""MalikVerse-compatible Flask API adapted from the upstream PytubeFix project.

Use only for videos you own, have permission to download, or that are otherwise
lawful to download. YouTube may restrict requests from some hosting providers.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from pytubefix import YouTube

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024
CORS(app, resources={r"/api/*": {"origins": os.getenv("ALLOWED_ORIGINS", "*").split(",")}})
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("malikverse-api")

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
}
QUALITY_HEIGHTS = {"2160p": 2160, "1440p": 1440, "1080p": 1080, "720p": 720,
                   "480p": 480, "360p": 360, "240p": 240, "144p": 144}


def normalize_youtube_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 2048:
        return None
    if not re.match(r"^https?://", value, re.I):
        value = "https://" + value
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or host not in YOUTUBE_HOSTS:
        return None
    if host.endswith("youtu.be"):
        video_id = parsed.path.strip("/").split("/")[0]
        return value if re.fullmatch(r"[A-Za-z0-9_-]{6,20}", video_id or "") else None
    if parsed.path == "/watch":
        ids = parse_qs(parsed.query).get("v", [])
        return value if ids and re.fullmatch(r"[A-Za-z0-9_-]{6,20}", ids[0]) else None
    if re.match(r"^/(shorts|embed|live)/[A-Za-z0-9_-]{6,20}(?:/|$)", parsed.path):
        return value
    return None


def request_data() -> dict:
    data = request.get_json(silent=True)
    merged = dict(request.args)
    merged.update(request.form.to_dict())
    if isinstance(data, dict):
        merged.update(data)
    return merged


def api_error(message: str, status: int = 400):
    return jsonify({"ok": False, "error": message, "message": message}), status


def format_duration(seconds: object) -> str | None:
    if not isinstance(seconds, (int, float)) or seconds < 0:
        return None
    total = int(seconds)
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours}:{minutes:02}:{secs:02}" if hours else f"{minutes}:{secs:02}"


def yt_streams(yt: YouTube) -> list:
    # Force stream discovery inside the error-handling boundary.
    return list(yt.streams)


def resolution_height(stream) -> int:
    value = getattr(stream, "resolution", None) or ""
    match = re.fullmatch(r"(\d+)p", str(value))
    return int(match.group(1)) if match else 0


def stream_ext(stream) -> str:
    return str(getattr(stream, "subtype", "") or "").lower()


def stream_has_audio(stream) -> bool:
    return bool(getattr(stream, "includes_audio_track", False))


def stream_has_video(stream) -> bool:
    # Older PytubeFix stream objects may not expose includes_video_track;
    # a resolution is a dependable indicator for the video streams we use.
    return resolution_height(stream) > 0


def audio_bitrate(stream) -> int:
    match = re.search(r"(\d+)", str(getattr(stream, "abr", "") or ""))
    return int(match.group(1)) if match else 0


def get_video_info(url: str) -> dict:
    yt = YouTube(url)
    streams = yt_streams(yt)
    best_by_height: dict[int, dict] = {}
    audio_formats: dict[str, dict] = {}
    for stream in streams:
        height = resolution_height(stream)
        ext = stream_ext(stream)
        itag = str(getattr(stream, "itag", ""))
        if height:
            candidate = {
                "formatId": itag,
                "quality": f"{height}p",
                "resolution": f"{height}p",
                "height": height,
                "ext": ext,
                "hasAudio": stream_has_audio(stream),
                "filesize": getattr(stream, "filesize", None),
            }
            current = best_by_height.get(height)
            score = (ext == "mp4", candidate["hasAudio"], candidate["filesize"] or 0)
            old_score = (current.get("ext") == "mp4", current.get("hasAudio", False), current.get("filesize") or 0) if current else None
            if current is None or score > old_score:
                best_by_height[height] = candidate
        elif getattr(stream, "includes_audio_track", False):
            audio_formats[itag] = {
                "formatId": itag, "ext": ext,
                "abr": getattr(stream, "abr", None),
                "filesize": getattr(stream, "filesize", None),
            }

    videos = sorted(best_by_height.values(), key=lambda item: item["height"], reverse=True)
    audios = sorted(audio_formats.values(), key=lambda item: audio_bitrate_from_payload(item), reverse=True)
    video_id = getattr(yt, "video_id", None)
    published = getattr(yt, "publish_date", None)
    return {
        "ok": True,
        "id": video_id,
        "title": getattr(yt, "title", None) or "YouTube video",
        "thumbnail": getattr(yt, "thumbnail_url", None),
        "thumbnailUrl": getattr(yt, "thumbnail_url", None),
        "duration": getattr(yt, "length", None),
        "durationFormatted": format_duration(getattr(yt, "length", None)),
        "uploader": getattr(yt, "author", None),
        "author": getattr(yt, "author", None),
        "viewCount": getattr(yt, "views", None),
        "views": getattr(yt, "views", None),
        "description": getattr(yt, "description", None) or "",
        "uploadDate": published.isoformat() if hasattr(published, "isoformat") else published,
        "videoUrl": url,
        "embedUrl": f"https://www.youtube.com/embed/{video_id}" if video_id else None,
        "videoFormats": videos,
        "audioFormats": audios,
        "availableResolutions": [item["quality"] for item in videos],
    }


def audio_bitrate_from_payload(item: dict) -> int:
    match = re.search(r"(\d+)", str(item.get("abr") or ""))
    return int(match.group(1)) if match else 0


def choose_video_stream(streams: list, data: dict):
    requested_itag = str(data.get("formatId") or data.get("format_id") or "").strip()
    if requested_itag and requested_itag.isdigit():
        selected = next((s for s in streams if str(getattr(s, "itag", "")) == requested_itag and stream_has_video(s)), None)
        if selected:
            return selected

    quality = str(data.get("quality") or data.get("resolution") or data.get("height") or "best").lower().strip()
    target = QUALITY_HEIGHTS.get(quality)
    if not target and quality.isdigit():
        target = int(quality)

    mp4_videos = [s for s in streams if stream_has_video(s) and stream_ext(s) == "mp4"]
    candidates = mp4_videos
    if target:
        bounded = [s for s in candidates if resolution_height(s) <= target]
        candidates = bounded or candidates
    if not candidates:
        # Fall back to a stream of another container type if MP4 video is absent.
        candidates = [s for s in streams if stream_has_video(s)]
        if target:
            bounded = [s for s in candidates if resolution_height(s) <= target]
            candidates = bounded or candidates
    if not candidates:
        raise RuntimeError("इस वीडियो के लिए compatible video stream नहीं मिला।")
    # Choose the highest allowed resolution. For ties, prefer a stream that
    # already contains audio, so low-resolution downloads avoid a merge step.
    return max(candidates, key=lambda s: (resolution_height(s), stream_has_audio(s), stream_ext(s) == "mp4", int(getattr(s, "fps", 0) or 0)))


def choose_audio_stream(streams: list):
    candidates = [s for s in streams if getattr(s, "includes_audio_track", False) and not stream_has_video(s)]
    if not candidates:
        candidates = [s for s in streams if getattr(s, "includes_audio_track", False)]
    if not candidates:
        raise RuntimeError("इस वीडियो के लिए audio stream नहीं मिला।")
    return max(candidates, key=lambda s: (stream_ext(s) == "mp4", audio_bitrate(s)))


def run_ffmpeg(args: list[str]) -> None:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("इस quality/MP3 download के लिए FFmpeg आवश्यक है। Hosting में दिए गए Dockerfile का उपयोग करें।")
    result = subprocess.run(args, capture_output=True, text=True, timeout=240, check=False)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "FFmpeg processing failed")[-900:]
        raise RuntimeError(message)


def build_download(url: str, data: dict) -> tuple[str, str]:
    temp_dir = tempfile.mkdtemp(prefix="malikverse-download-")
    try:
        yt = YouTube(url)
        streams = yt_streams(yt)
        kind = str(data.get("type") or data.get("mode") or data.get("formatType") or data.get("format") or "video").lower().strip()
        audio_only = str(data.get("audioOnly") or data.get("audio_only") or "").lower() in ("1", "true", "yes")
        want_mp3 = kind in ("audio", "mp3", "music", "m4a") or audio_only

        if want_mp3:
            audio = choose_audio_stream(streams)
            source_path = audio.download(output_path=temp_dir)
            output_path = os.path.join(temp_dir, "malikverse-audio.mp3")
            run_ffmpeg(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", source_path,
                        "-vn", "-codec:a", "libmp3lame", "-b:a", "192k", output_path])
            return temp_dir, output_path

        video = choose_video_stream(streams, data)
        if stream_has_audio(video):
            video_path = video.download(output_path=temp_dir)
            # If the stream is MP4, the original progressive stream is already browser-ready.
            if stream_ext(video) == "mp4":
                return temp_dir, video_path
            output_path = os.path.join(temp_dir, "malikverse-video.mp4")
            run_ffmpeg(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", video_path,
                        "-c", "copy", "-movflags", "+faststart", output_path])
            return temp_dir, output_path

        audio = choose_audio_stream(streams)
        video_path = video.download(output_path=temp_dir)
        audio_path = audio.download(output_path=temp_dir)
        output_path = os.path.join(temp_dir, "malikverse-video.mp4")
        run_ffmpeg(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", video_path,
                    "-i", audio_path, "-c", "copy", "-movflags", "+faststart", output_path])
        return temp_dir, output_path
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


def send_download(url: str, data: dict):
    try:
        temp_dir, file_path = build_download(url, data)
        response = send_file(file_path, as_attachment=True, download_name=Path(file_path).name,
                             conditional=True, max_age=0)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.call_on_close(lambda: shutil.rmtree(temp_dir, ignore_errors=True))
        return response
    except Exception as exc:
        logger.warning("Download failed: %s", exc)
        detail = str(exc)
        if any(token in detail.lower() for token in ("sign in to confirm", "not a bot", "confirm you're not a bot", "http error 403", "http error 429")):
            detail = "YouTube ने hosting server की request रोक दी है। यह code change अकेले verification को ठीक नहीं कर सकता।"
        return api_error(f"Download नहीं हो सका: {detail[:400]}", 502)


@app.get("/")
def home():
    return jsonify({"ok": True, "service": "MalikVerse YouTube API", "health": "/api/status"})


@app.get("/api/status")
@app.get("/api/health")
def api_status():
    return jsonify({
        "ok": True,
        "status": "ok",
        "state": "online",
        "service": "MalikVerse YouTube API",
        "engine": "pytubefix",
        "pytubefixInstalled": True,
        "ffmpegInstalled": bool(shutil.which("ffmpeg")),
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "capabilities": {"video": True, "mp3": bool(shutil.which("ffmpeg")), "metadata": True},
        "note": "YouTube can restrict requests from some hosting IP addresses; all videos are not guaranteed to work.",
    })


@app.route("/api/info", methods=["GET", "POST"])
@app.route("/video_info", methods=["GET", "POST"])
def api_info():
    data = request_data()
    url = normalize_youtube_url(data.get("url") or data.get("youtubeUrl") or data.get("link"))
    if not url:
        return api_error("Valid YouTube video URL भेजें।", 400)
    try:
        return jsonify(get_video_info(url)), 200
    except Exception as exc:
        logger.warning("Metadata extraction failed: %s", exc)
        detail = str(exc)
        if any(token in detail.lower() for token in ("sign in to confirm", "not a bot", "confirm you're not a bot")):
            detail = "YouTube ने hosting server की request रोक दी है; यह code change अकेले verification को ठीक नहीं कर सकता।"
        return api_error(f"वीडियो की जानकारी नहीं मिल सकी: {detail[:300]}", 502)


@app.route("/available_resolutions", methods=["GET", "POST"])
def available_resolutions():
    data = request_data()
    url = normalize_youtube_url(data.get("url") or data.get("youtubeUrl") or data.get("link"))
    if not url:
        return api_error("Valid YouTube video URL भेजें।", 400)
    try:
        payload = get_video_info(url)
        return jsonify({"ok": True, "progressive": payload["availableResolutions"],
                        "all": payload["availableResolutions"], "videoFormats": payload["videoFormats"]}), 200
    except Exception as exc:
        logger.warning("Format listing failed: %s", exc)
        return api_error(f"Available qualities नहीं मिल सकीं: {str(exc)[:300]}", 502)


@app.route("/api/download", methods=["GET", "POST"])
def api_download():
    data = request_data()
    url = normalize_youtube_url(data.get("url") or data.get("youtubeUrl") or data.get("link"))
    if not url:
        return api_error("Valid YouTube video URL भेजें।", 400)
    return send_download(url, data)


@app.post("/download/<resolution>")
def legacy_download(resolution: str):
    data = request_data()
    data["quality"] = resolution
    url = normalize_youtube_url(data.get("url") or data.get("youtubeUrl") or data.get("link"))
    if not url:
        return api_error("Valid YouTube video URL भेजें।", 400)
    return send_download(url, data)


@app.errorhandler(413)
def too_large(_exc):
    return api_error("Request बहुत बड़ी है; केवल YouTube URL और quality भेजें।", 413)


@app.errorhandler(404)
def not_found(_exc):
    return api_error("API route नहीं मिला। /api/status से service check करें।", 404)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False)
