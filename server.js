"use strict";

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT) || 3000;

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "1mb" }));

/* =========================================================
   CONFIG
========================================================= */

const BIN_DIR = path.join(os.tmpdir(), "clipflow-bin");
const YTDLP_BIN = path.join(BIN_DIR, "yt-dlp");

let cachedYtDlpPath = null;
let cachedYtDlpVersion = null;

/* =========================================================
   BASIC HELPERS
========================================================= */

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isYouTubeUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();

    const allowedHosts = new Set([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "www.youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ]);

    return allowedHosts.has(host);
  } catch {
    return false;
  }
}

function cleanFileName(name) {
  return String(name || "clipflow-download")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

function getOutputFile(tempDir) {
  const files = fs
    .readdirSync(tempDir)
    .filter((file) => {
      const lower = file.toLowerCase();

      return (
        !lower.endsWith(".part") &&
        !lower.endsWith(".ytdl") &&
        !lower.endsWith(".temp") &&
        !lower.endsWith(".json")
      );
    });

  if (!files.length) {
    return null;
  }

  // Prefer larger files
  files.sort((a, b) => {
    try {
      const sizeA = fs.statSync(path.join(tempDir, a)).size;
      const sizeB = fs.statSync(path.join(tempDir, b)).size;
      return sizeB - sizeA;
    } catch {
      return 0;
    }
  });

  return path.join(tempDir, files[0]);
}

/* =========================================================
   COMMAND CHECK
========================================================= */

function checkCommand(command, args = ["--version"]) {
  return new Promise((resolve) => {
    let settled = false;

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.on("error", () => {
      finish({
        available: false,
        version: null,
      });
    });

    child.on("close", (code) => {
      finish({
        available: code === 0,
        version: stdout.trim() || null,
      });
    });
  });
}

/* =========================================================
   FIND FFMPEG
========================================================= */

async function findFfmpeg() {
  const possiblePaths = [
    process.env.FFMPEG_PATH,
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/ffmpeg/bin/ffmpeg",
  ].filter(Boolean);

  for (const filePath of possiblePaths) {
    if (fileExists(filePath) && isExecutable(filePath)) {
      return filePath;
    }
  }

  const pathCheck = await checkCommand("ffmpeg", ["-version"]);

  if (pathCheck.available) {
    return "ffmpeg";
  }

  return null;
}

/* =========================================================
   DOWNLOAD FILE WITH REDIRECT SUPPORT
========================================================= */

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "ClipFlow/1.0",
          Accept: "*/*",
        },
      },
      (response) => {
        // Redirect
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();

          return downloadFile(response.headers.location, destination)
            .then(resolve)
            .catch(reject);
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              `Could not download yt-dlp binary. HTTP ${response.statusCode}`
            )
          );
          return;
        }

        const fileStream = fs.createWriteStream(destination);

        response.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close(() => {
            try {
              const stat = fs.statSync(destination);

              if (stat.size < 500000) {
                fs.rmSync(destination, {
                  force: true,
                });

                reject(
                  new Error(
                    "Downloaded yt-dlp binary looks invalid or incomplete."
                  )
                );
                return;
              }

              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });

        fileStream.on("error", (error) => {
          try {
            fs.rmSync(destination, {
              force: true,
            });
          } catch {}

          reject(error);
        });

        response.on("error", (error) => {
          try {
            fs.rmSync(destination, {
              force: true,
            });
          } catch {}

          reject(error);
        });
      }
    );

    request.setTimeout(120000, () => {
      request.destroy(new Error("yt-dlp binary download timed out."));
    });

    request.on("error", reject);
  });
}

/* =========================================================
   DETERMINE LINUX BINARY
========================================================= */

function getYtDlpAssetName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") {
    return "yt-dlp_linux";
  }

  if (platform === "linux" && arch === "arm64") {
    return "yt-dlp_linux_aarch64";
  }

  throw new Error(
    `Unsupported platform for automatic yt-dlp setup: ${platform}/${arch}`
  );
}

/* =========================================================
   FIND EXISTING YT-DLP
========================================================= */

async function findExistingYtDlp() {
  const possiblePaths = [
    process.env.YT_DLP_PATH,

    path.join(process.cwd(), "yt-dlp"),
    path.join(process.cwd(), "bin", "yt-dlp"),

    "/usr/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/opt/yt-dlp/yt-dlp",

    YTDLP_BIN,
  ].filter(Boolean);

  for (const filePath of possiblePaths) {
    if (!fileExists(filePath)) {
      continue;
    }

    // Try executable binary
    if (isExecutable(filePath)) {
      const check = await checkCommand(filePath, ["--version"]);

      if (check.available) {
        return {
          path: filePath,
          version: check.version,
        };
      }
    }
  }

  // Try PATH command
  const pathCheck = await checkCommand("yt-dlp", ["--version"]);

  if (pathCheck.available) {
    return {
      path: "yt-dlp",
      version: pathCheck.version,
    };
  }

  return null;
}

/* =========================================================
   ENSURE YT-DLP
========================================================= */

async function ensureYtDlp() {
  if (cachedYtDlpPath) {
    return {
      path: cachedYtDlpPath,
      version: cachedYtDlpVersion,
    };
  }

  // 1. Check existing installation
  const existing = await findExistingYtDlp();

  if (existing) {
    cachedYtDlpPath = existing.path;
    cachedYtDlpVersion = existing.version;

    console.log(
      `yt-dlp found: ${existing.path} (${existing.version || "unknown"})`
    );

    return existing;
  }

  // 2. Create temporary binary directory
  fs.mkdirSync(BIN_DIR, {
    recursive: true,
  });

  const assetName = getYtDlpAssetName();

  const downloadUrl =
    `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;

  console.log(`yt-dlp not found. Downloading official binary: ${assetName}`);

  // Clean old broken binary
  try {
    if (fileExists(YTDLP_BIN)) {
      fs.rmSync(YTDLP_BIN, {
        force: true,
      });
    }
  } catch {}

  await downloadFile(downloadUrl, YTDLP_BIN);

  fs.chmodSync(YTDLP_BIN, 0o755);

  const verification = await checkCommand(YTDLP_BIN, ["--version"]);

  if (!verification.available) {
    try {
      fs.rmSync(YTDLP_BIN, {
        force: true,
      });
    } catch {}

    throw new Error(
      "yt-dlp binary downloaded but could not be executed."
    );
  }

  cachedYtDlpPath = YTDLP_BIN;
  cachedYtDlpVersion = verification.version;

  console.log(
    `yt-dlp ready: ${cachedYtDlpPath} (${cachedYtDlpVersion || "unknown"})`
  );

  return {
    path: cachedYtDlpPath,
    version: cachedYtDlpVersion,
  };
}

/* =========================================================
   RUN YT-DLP
========================================================= */

async function runYtDlp(args, options = {}) {
  const yt = await ensureYtDlp();

  const baseArgs = [
    "--no-playlist",
    "--no-warnings",

    // Current YouTube extraction needs an external JS runtime.
    "--js-runtimes",
    `node:${process.execPath}`,

    // Let yt-dlp retrieve current EJS components from GitHub when needed.
    "--remote-components",
    "ejs:github",
  ];

  const finalArgs = [...baseArgs, ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(yt.path, finalArgs, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
          code,
          ytDlpPath: yt.path,
          ytDlpVersion: yt.version,
        });
        return;
      }

      const message =
        stderr.trim() ||
        stdout.trim() ||
        `yt-dlp exited with code ${code}`;

      reject(new Error(message));
    });
  });
}

/* =========================================================
   HEALTH / STATUS
========================================================= */

app.get("/", async (req, res) => {
  res.json({
    success: true,
    service: "ClipFlow YouTube Downloader",
    status: "online",
    version: "2.0.0",
  });
});

app.get("/api/status", async (req, res) => {
  try {
    const yt = await ensureYtDlp();
    const ffmpeg = await findFfmpeg();

    res.json({
      success: true,
      status: "online",
      service: "ClipFlow YouTube Downloader",
      ytdlp: {
        available: true,
        path: yt.path,
        version: yt.version,
      },
      ffmpeg: {
        available: Boolean(ffmpeg),
        path: ffmpeg || null,
      },
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
  } catch (error) {
    console.error("STATUS ERROR:", error);

    res.status(500).json({
      success: false,
      status: "offline",
      error: error.message,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
  }
});

/* =========================================================
   VIDEO INFO
========================================================= */

app.post("/api/info", async (req, res) => {
  try {
    const { url } = req.body || {};

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "YouTube URL is required.",
      });
    }

    if (!isYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Please provide a valid YouTube URL.",
      });
    }

    console.log(`Fetching info: ${url}`);

    const result = await runYtDlp([
      "--dump-single-json",
      "--skip-download",
      "--no-progress",
      url,
    ]);

    let info;

    try {
      info = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        "Could not parse YouTube information from yt-dlp."
      );
    }

    res.json({
      success: true,
      data: {
        id: info.id || "",
        title: info.title || "YouTube Video",
        description: info.description || "",
        thumbnail:
          info.thumbnail ||
          (info.id
            ? `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`
            : ""),

        duration: Number(info.duration || 0),

        uploader:
          info.uploader ||
          info.channel ||
          "",

        channel:
          info.channel ||
          info.uploader ||
          "",

        uploadDate: info.upload_date || "",
        webpage_url: info.webpage_url || url,

        width: info.width || null,
        height: info.height || null,

        viewCount:
          typeof info.view_count === "number"
            ? info.view_count
            : null,

        likeCount:
          typeof info.like_count === "number"
            ? info.like_count
            : null,
      },
    });
  } catch (error) {
    console.error("INFO ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Could not fetch video information.",
      details: error.message,
    });
  }
});

/* =========================================================
   DOWNLOAD
========================================================= */

app.post("/api/download", async (req, res) => {
  let tempDir = null;

  try {
    const {
      url,
      format = "video",
      quality = "720",
    } = req.body || {};

    if (!url) {
      return res.status(400).json({
        success: false,
        error: "YouTube URL is required.",
      });
    }

    if (!isYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error: "Please provide a valid YouTube URL.",
      });
    }

    const selectedFormat =
      String(format).toLowerCase() === "audio"
        ? "audio"
        : "video";

    const allowedQualities = [
      "144",
      "240",
      "360",
      "480",
      "720",
      "1080",
      "1440",
      "2160",
    ];

    const selectedQuality = allowedQualities.includes(
      String(quality)
    )
      ? String(quality)
      : "720";

    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "clipflow-download-")
    );

    const outputTemplate = path.join(
      tempDir,
      "%(title).150s.%(ext)s"
    );

    const ffmpeg = await findFfmpeg();

    let args = [];

    /* -------------------------------------------------------
       AUDIO
    ------------------------------------------------------- */

    if (selectedFormat === "audio") {
      if (ffmpeg) {
        args = [
          "-f",
          "bestaudio/best",

          "--extract-audio",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "0",

          "-o",
          outputTemplate,

          url,
        ];
      } else {
        // No ffmpeg:
        // download the original best audio instead of failing.
        args = [
          "-f",
          "bestaudio/best",

          "-o",
          outputTemplate,

          url,
        ];
      }
    }

    /* -------------------------------------------------------
       VIDEO
    ------------------------------------------------------- */

    else {
      if (ffmpeg) {
        // Best video + best audio and merge into MP4.
        args = [
          "-f",
          `bestvideo[height<=${selectedQuality}]+bestaudio/best[height<=${selectedQuality}]/best`,

          "--merge-output-format",
          "mp4",

          "-o",
          outputTemplate,

          url,
        ];
      } else {
        // Fallback without ffmpeg:
        // download a pre-merged/progressive video.
        args = [
          "-f",
          `best[height<=${selectedQuality}]/best`,

          "-o",
          outputTemplate,

          url,
        ];
      }
    }

    console.log(
      `Download requested | format=${selectedFormat} | quality=${selectedQuality} | ffmpeg=${Boolean(
        ffmpeg
      )}`
    );

    await runYtDlp(args);

    const filePath = getOutputFile(tempDir);

    if (!filePath) {
      throw new Error(
        "Download finished but no output file was created."
      );
    }

    if (!fileExists(filePath)) {
      throw new Error("Downloaded file was not found.");
    }

    const originalName = path.basename(filePath);

    const extension =
      path.extname(originalName).toLowerCase() || ".mp4";

    const baseName = cleanFileName(
      path.basename(originalName, extension)
    );

    const downloadName =
      baseName +
      (selectedFormat === "audio" && ffmpeg
        ? ".mp3"
        : extension);

    // Correct content type
    let contentType = "application/octet-stream";

    if (extension === ".mp4") {
      contentType = "video/mp4";
    } else if (extension === ".webm") {
      contentType = "video/webm";
    } else if (extension === ".mkv") {
      contentType = "video/x-matroska";
    } else if (extension === ".mp3") {
      contentType = "audio/mpeg";
    } else if (extension === ".m4a") {
      contentType = "audio/mp4";
    } else if (extension === ".opus") {
      contentType = "audio/ogg";
    }

    const stat = fs.statSync(filePath);

    res.setHeader(
      "Content-Type",
      contentType
    );

    res.setHeader(
      "Content-Length",
      stat.size
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(
        downloadName
      )}"`
    );

    const stream = fs.createReadStream(filePath);

    stream.on("error", (error) => {
      console.error("FILE STREAM ERROR:", error);

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: "Could not read downloaded file.",
        });
      }
    });

    stream.on("close", () => {
      cleanupTempDir(tempDir);
      tempDir = null;
    });

    stream.pipe(res);
  } catch (error) {
    console.error("DOWNLOAD ERROR:", error);

    if (tempDir) {
      cleanupTempDir(tempDir);
      tempDir = null;
    }

    let userMessage = "Download failed.";

    const details = String(error.message || "");

    if (
      details.toLowerCase().includes("sign in") ||
      details.toLowerCase().includes("authentication")
    ) {
      userMessage =
        "YouTube requires authentication for this video.";
    } else if (
      details.toLowerCase().includes("private video")
    ) {
      userMessage = "This video is private.";
    } else if (
      details.toLowerCase().includes("not available")
    ) {
      userMessage = "This video is not available.";
    }

    res.status(500).json({
      success: false,
      error: userMessage,
      details,
    });
  }
});

/* =========================================================
   CLEANUP
========================================================= */

function cleanupTempDir(dir) {
  if (!dir) return;

  try {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.error(
      "Cleanup error:",
      error.message
    );
  }
}

/* =========================================================
   EXPRESS ERROR HANDLER
========================================================= */

app.use((err, req, res, next) => {
  console.error("EXPRESS ERROR:", err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    error: "Internal server error.",
    details: err.message,
  });
});

/* =========================================================
   START SERVER
========================================================= */

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `ClipFlow server running on 0.0.0.0:${PORT}`
    );
    console.log(
      `Node version: ${process.version}`
    );
    console.log(
      `Platform: ${process.platform}/${process.arch}`
    );
  }
);

// Allow long YouTube downloads.
server.timeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

/* =========================================================
   BACKGROUND CHECK
========================================================= */

ensureYtDlp()
  .then(async (yt) => {
    const ffmpeg = await findFfmpeg();

    console.log(
      `Startup yt-dlp: ${yt.version || "ready"}`
    );

    console.log(
      `Startup ffmpeg: ${
        ffmpeg ? "available" : "not available"
      }`
    );
  })
  .catch((error) => {
    console.error(
      "Startup yt-dlp setup warning:",
      error.message
    );

    console.error(
      "The server is still running. /api/status will show the actual problem."
    );
  });
