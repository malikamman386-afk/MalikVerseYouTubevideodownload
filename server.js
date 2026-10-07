const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

/* -----------------------------
   Helpers
----------------------------- */

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);

    const hosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be",
      "www.youtu.be"
    ];

    return hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const process = spawn("python3", ["-m", "yt_dlp", ...args], {
      env: {
        ...global.process.env,
        PYTHONUNBUFFERED: "1"
      }
    });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", (error) => {
      reject(error);
    });

    process.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
      } else {
        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `yt-dlp exited with code ${code}`
          )
        );
      }
    });
  });
}

/* -----------------------------
   Basic routes
----------------------------- */

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "ClipFlow YouTube Downloader",
    status: "online"
  });
});

app.get("/api/status", async (req, res) => {
  try {
    await runYtDlp(["--version"]);

    res.json({
      success: true,
      status: "online",
      service: "ClipFlow YouTube Downloader",
      ytdlp: "available"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: "offline",
      error: error.message
    });
  }
});

/* -----------------------------
   Video information
----------------------------- */

app.post("/api/info", async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url || !isYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Please provide a valid YouTube URL."
      });
    }

    const result = await runYtDlp([
      "--dump-single-json",
      "--no-playlist",
      "--skip-download",
      "--no-warnings",
      url
    ]);

    const info = JSON.parse(result.stdout);

    res.json({
      success: true,
      data: {
        id: info.id || "",
        title: info.title || "YouTube Video",
        thumbnail:
          info.thumbnail ||
          `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
        duration: info.duration || 0,
        uploader: info.uploader || "",
        webpage_url: info.webpage_url || url
      }
    });
  } catch (error) {
    console.error("INFO ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Could not fetch video information.",
      details: error.message
    });
  }
});

/* -----------------------------
   Download
----------------------------- */

app.post("/api/download", async (req, res) => {
  let tempDir = null;

  try {
    const {
      url,
      format = "video",
      quality = "720"
    } = req.body || {};

    if (!url || !isYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Please provide a valid YouTube URL."
      });
    }

    const allowedQualities = ["360", "720", "1080"];

    const selectedQuality = allowedQualities.includes(String(quality))
      ? String(quality)
      : "720";

    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clipflow-")
    );

    const outputTemplate = path.join(
      tempDir,
      "%(title).150s.%(ext)s"
    );

    let args;

    if (format === "audio") {
      args = [
        "--no-playlist",
        "--no-warnings",
        "-f",
        "bestaudio",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "-o",
        outputTemplate,
        url
      ];
    } else {
      args = [
        "--no-playlist",
        "--no-warnings",
        "-f",
        `bestvideo[height<=${selectedQuality}]+bestaudio/best[height<=${selectedQuality}]/best`,
        "--merge-output-format",
        "mp4",
        "-o",
        outputTemplate,
        url
      ];
    }

    await runYtDlp(args);

    const files = fs
      .readdirSync(tempDir)
      .filter((file) => !file.endsWith(".part"));

    if (!files.length) {
      throw new Error("Downloaded file was not created.");
    }

    const fileName = files[0];
    const filePath = path.join(tempDir, fileName);

    if (!fs.existsSync(filePath)) {
      throw new Error("Downloaded file could not be found.");
    }

    const extension =
      format === "audio" ? ".mp3" : ".mp4";

    const safeBaseName = path
      .basename(fileName)
      .replace(/\.[^/.]+$/, "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .trim()
      .slice(0, 150);

    const downloadName =
      (safeBaseName || "clipflow-download") + extension;

    res.download(
      filePath,
      downloadName,
      (error) => {
        try {
          fs.rmSync(tempDir, {
            recursive: true,
            force: true
          });
        } catch {}

        if (error && !res.headersSent) {
          res.status(500).json({
            success: false,
            error: "Could not send downloaded file."
          });
        }
      }
    );
  } catch (error) {
    console.error("DOWNLOAD ERROR:", error);

    if (tempDir) {
      try {
        fs.rmSync(tempDir, {
          recursive: true,
          force: true
        });
      } catch {}
    }

    res.status(500).json({
      success: false,
      error: "Download failed.",
      details: error.message
    });
  }
});

/* -----------------------------
   Error handler
----------------------------- */

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

/* -----------------------------
   Start server
----------------------------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `ClipFlow server running on 0.0.0.0:${PORT}`
  );
});
