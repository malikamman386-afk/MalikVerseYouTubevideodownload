# MalikVerse-compatible YouTube API

Flask API adapted from the public MIT-licensed project [zararashraf/youtube-video-downloader-api](https://github.com/zararashraf/youtube-video-downloader-api). It retains PytubeFix and adds MalikVerse-style `/api/*` endpoints, Shorts/short-link validation, file responses instead of a server-side-only success message, and FFmpeg merging for separate video/audio streams.

> Use only for videos you own, have permission to download, or that applicable licenses and local law allow you to download. Respect YouTube's terms. YouTube can restrict requests from cloud-hosting IPs; this project cannot guarantee all videos will be accessible.

## Endpoints

- `GET /api/status` or `GET /api/health` — service/dependency status.
- `POST /api/info` (also `GET /api/info`) — video metadata and available qualities. JSON body: `{"url":"https://www.youtube.com/watch?v=VIDEO_ID"}`.
- `POST /api/download` — returns media as a downloadable file. JSON examples:
  - `{"url":"https://www.youtube.com/watch?v=VIDEO_ID","quality":"720p"}`
  - `{"url":"https://www.youtube.com/watch?v=VIDEO_ID","type":"audio"}` (MP3; FFmpeg required)
- `POST /available_resolutions` — legacy resolutions endpoint.
- `POST /download/720p` — legacy route alias; responds with the file itself.
- URL support includes regular videos, `youtu.be`, Shorts, live and embed URLs.

`/api/info` returns `title`, `thumbnail`, `duration`, `durationFormatted`, `uploader`, `viewCount`, `videoFormats`, `audioFormats`, and `availableResolutions`.

## Deploy with Docker (recommended)

Deploy this repository on a host that supports Docker. The included Dockerfile installs FFmpeg and starts the app with Gunicorn. The service listens on the hosting platform's `PORT` variable (or port 5000 locally).

## Run locally

Python 3.11+ and FFmpeg are recommended.

```bash
pip install -r requirements.txt
python main.py
```

Set `ALLOWED_ORIGINS` to your frontend origin(s), comma-separated. It defaults to `*` for testing; restrict it to your website domain in production.

## Frontend integration

Set the frontend's API base URL to your deployed backend domain. `/api/download` returns the actual file, not JSON claiming it was saved on the server. The frontend should handle that response as a binary/blob download and send `url` plus optional `quality`, `formatId`, or `type` (`audio` for MP3).

## Troubleshooting

- FFmpeg missing: use the included Dockerfile or install FFmpeg on the host.
- YouTube verification/bot check: some host IPs are challenged or blocked. Changing quality does not fix that by itself, and this code does not bypass access restrictions.
- CORS: set `ALLOWED_ORIGINS` to the exact frontend origin(s).

## License

The original MIT license and upstream copyright notice are included in `LICENSE`.
