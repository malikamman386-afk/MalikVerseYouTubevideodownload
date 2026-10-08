🎬 ClipFlow — YouTube Video Downloader

<p align="center">
  <strong>Fast • Simple • Mobile Friendly • No Sign-Up</strong>
</p><p align="center">
  A lightweight YouTube downloader backend powered by Node.js, Express, yt-dlp and FFmpeg.
</p>---

✨ About ClipFlow

ClipFlow is a simple and modern YouTube downloading service designed to make video and audio downloading easy.

It provides a lightweight backend API that can:

- 🎥 Download YouTube videos
- 🎵 Extract audio as MP3
- 📺 Support different video qualities
- 🖼️ Fetch video information and thumbnails
- 📱 Work with mobile and desktop frontends
- ⚡ Run on Railway using Docker
- 🔗 Connect with a separate static frontend

---

🚀 Features

Feature| Status
🎥 Video Download| ✅
🎵 MP3 Audio Extraction| ✅
🖼️ Video Information| ✅
🔗 YouTube URL Validation| ✅
📱 Mobile Friendly API| ✅
⚡ Fast Processing| ✅
🐳 Docker Support| ✅
☁️ Railway Deployment| ✅
🔧 FFmpeg Processing| ✅
📦 Standalone yt-dlp| ✅
🔐 No User Account Required| ✅

---

🎞️ Supported Quality

ClipFlow supports multiple video quality options depending on what YouTube makes available for a particular video.

- 144p
- 240p
- 360p
- 480p
- 720p
- 1080p
- 1440p
- 2160p / 4K

«Available quality depends on the source video and YouTube's available formats.»

---

🎵 Audio

ClipFlow can extract audio from supported YouTube videos and convert it to:

MP3

Audio extraction uses FFmpeg for processing.

---

🛠️ Tech Stack

ClipFlow is built using simple and reliable technologies:

- 🟢 Node.js
- 🚂 Express.js
- 🎬 yt-dlp
- 🎞️ FFmpeg
- 🐳 Docker
- ☁️ Railway
- 🌐 REST API

---

📁 Project Structure

MalikVerseYouTubevideodownload/
│
├── server.js
├── package.json
├── Dockerfile
├── nixpacks.toml
└── README.md

---

🔌 API

Server Status

GET /api/status

Returns the current server status and checks whether yt-dlp and FFmpeg are available.

Example

/api/status

---

📋 Get Video Information

POST /api/info

Request

{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID"
}

Response

{
  "success": true,
  "data": {
    "id": "VIDEO_ID",
    "title": "YouTube Video",
    "thumbnail": "https://...",
    "duration": 120,
    "uploader": "Channel Name"
  }
}

---

⬇️ Download Video

POST /api/download

Request

{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "type": "video",
  "quality": "720"
}

Supported Types

video
audio

Example

{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "type": "video",
  "quality": "1080"
}

---

🎵 Download Audio

{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "type": "audio"
}

When FFmpeg is available, the audio is processed as:

MP3

---

🐳 Docker

ClipFlow includes a Railway-ready Docker configuration.

The Docker image provides:

- Node.js 20
- FFmpeg
- Standalone yt-dlp
- Production environment configuration

Build locally:

docker build -t clipflow .

Run:

docker run -p 3000:3000 clipflow

---

☁️ Railway Deployment

ClipFlow can be deployed directly to Railway using the included "Dockerfile".

Basic deployment flow

GitHub
   ↓
Railway
   ↓
Docker Build
   ↓
Node.js Server
   ↓
yt-dlp + FFmpeg
   ↓
ClipFlow API

Railway automatically provides the "PORT" environment variable, which the server uses automatically.

---

⚙️ Environment Variables

ClipFlow works with sensible defaults, but the following variables can optionally be configured:

PORT
YT_DLP_PATH
FFMPEG_PATH
NODE_ENV

Example:

NODE_ENV=production

---

🌐 Frontend

ClipFlow can be connected to any frontend capable of making HTTP requests.

For example:

Static HTML
      ↓
ClipFlow Frontend
      ↓
Railway API
      ↓
yt-dlp
      ↓
YouTube

The frontend can be hosted separately from the backend.

This makes it possible to host the frontend on a normal web-hosting service while keeping the downloader API on Railway.

---

📱 Mobile Support

The API is designed to work with:

- 📱 Android
- 🍎 iPhone
- 💻 Windows
- 🖥️ macOS
- 🐧 Linux
- 🌐 Modern web browsers

The frontend is responsible for the user interface, while the backend handles downloading and media processing.

---

⚠️ Important

YouTube may temporarily reject automated requests or require additional verification.

For example:

Sign in to confirm you're not a bot

This can happen because of YouTube's server-side anti-bot systems, IP reputation, traffic limits, or other restrictions.

ClipFlow does not guarantee that every YouTube video will always be downloadable.

Private, unavailable, age-restricted, region-restricted, or otherwise protected content may fail.

---

🔒 Privacy

ClipFlow is designed without requiring users to create an account.

The backend does not need a user password or Google account credentials to operate.

«Never place personal Google/YouTube cookies, passwords, session tokens, or other private credentials inside a public repository or public server configuration.»

---

📜 Legal & Responsible Use

ClipFlow is intended for downloading content that you have permission to download or that is otherwise legally available for your intended use.

Users are responsible for complying with:

- YouTube's Terms of Service
- Copyright laws
- Applicable local laws
- Content owner's rights

Do not use ClipFlow to download or redistribute copyrighted content without the necessary permission.

---

❤️ Project

Built with:

Node.js + Express + yt-dlp + FFmpeg

Made for a simple, fast and clean downloading experience.

---

👨‍💻 Developer

MalikVerse

ClipFlow / MalikVerse YouTube Downloader

---

⭐ Support the Project

If you find this project useful:

⭐ Star the repository
🐛 Report bugs
💡 Suggest improvements
🚀 Help make ClipFlow better

---

<p align="center">
  <strong>🎬 ClipFlow</strong><br>
  Fast. Simple. Clean.
</p>
