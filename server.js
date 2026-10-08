"use strict";

/* =========================================================
   ClipFlow — YouTube Downloader Backend
   Production-ready for Railway (Docker)
   ========================================================= */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");

/* =========================================================
   CONFIG
   ========================================================= */

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const SERVICE_NAME = "ClipFlow YouTube Downloader";
const SERVICE_VERSION = "2.1.0";

const YTDLP_BIN_DIR = path.join(os.tmpdir(), "clipflow-bin");
const YTDLP_DOWNLOAD_PATH = path.join(YTDLP_BIN_DIR, "yt-dlp");

const YTDLP_CANDIDATES = [
  process.env.YT_DLP_PATH,
  "/usr/local/bin/yt-dlp",
  "/usr/bin/yt-dlp",
  "/opt/yt-dlp/yt-dlp",
  YTDLP_DOWNLOAD_PATH,
].filter(Boolean);

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/ffmpeg/bin/ffmpeg",
].filter(Boolean);

const ALLOWED_QUALITIES = [
  "144",
  "240",
  "360",
  "480",
  "720",
  "1080",
  "1440",
  "2160",
];

/* =========================================================
   APP SETUP
   ========================================================= */

const app = express();

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Origin"],
    maxAge: 86400,
  })
);

app.use(express.json({ limit: "1mb" }));

/* =========================================================
   CACHED BINARY LOOKUPS
   null   = not checked yet
   false  = unavailable
   object = available
   ========================================================= */

let cachedYtDlp = null;
let cachedFfmpeg = null;

/* =========================================================
   HELPERS
   ========================================================= */

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
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

    const allowed = new Set([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "www.youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ]);

    return allowed.has(host);
  } catch {
    return false;
  }
}

function cleanFileName(name, fallback = "clipflow-download") {
  const cleaned = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);

  return cleaned || fallback;
}

function detectContentType(ext) {
  const map = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
  };

  return map[ext] || "application/octet-stream";
}

function findOutputFile(dir) {
  if (!fileExists(dir)) {
    return null;
  }

  let files;

  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const filtered = files.filter((f) => {
    const lower = f.toLowerCase();

    return (
      !lower.endsWith(".part") &&
      !lower.endsWith(".ytdl") &&
      !lower.endsWith(".temp")
    );
  });

  if (!filtered.length) {
    return null;
  }

  let best = null;
  let bestSize = -1;

  for (const file of filtered) {
    try {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isFile() && stat.size > bestSize) {
        bestSize = stat.size;
        best = fullPath;
      }
    } catch {
      // Ignore inaccessible files
    }
  }

  return best;
}

function cleanupDir(dir) {
  if (!dir) {
    return;
  }

  try {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.error("[cleanup] failed:", error.message);
  }
}

/* =========================================================
   FRIENDLY ERROR MESSAGES
   ========================================================= */

function classifyError(msg) {
  if (!msg) {
    return null;
  }

  const m = String(msg).toLowerCase();

  if (
    m.includes("sign in to confirm you're not a bot") ||
    m.includes("sign in to confirm you are not a bot") ||
    m.includes("confirm you're not a bot") ||
    m.includes("confirm you are not a bot") ||
    m.includes("not a bot")
  ) {
    return "YouTube temporarily blocked this request because of an anti-bot check. Please try again later.";
  }

  if (m.includes("private video")) {
    return "This video is private.";
  }

  if (
    m.includes("sign in") ||
    m.includes("login required") ||
    m.includes("authentication required")
  ) {
    return "YouTube requires sign-in for this video.";
  }

  if (m.includes("age") && m.includes("restrict")) {
    return "This video is age-restricted.";
  }

  if (m.includes("geo") && m.includes("restrict")) {
    return "This video is not available in this region.";
  }

  if (m.includes("copyright")) {
    return "This video is blocked due to copyright.";
  }

  if (m.includes("unsupported url")) {
    return "This URL is not supported.";
  }

  if (
    m.includes("not available") ||
    m.includes("unavailable")
  ) {
    return "This video is not available.";
  }

  if (
    m.includes("http error 403") ||
    m.includes("http error 429") ||
    m.includes("too many requests")
  ) {
    return "YouTube temporarily rejected the request. Please try again later.";
  }

  if (
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("socket timeout")
  ) {
    return "The request timed out. Please try again.";
  }

  if (m.includes("no output file was produced")) {
    return "The video could not be downloaded.";
  }

  if (m.includes("yt-dlp is not available")) {
    return "Server is missing yt-dlp. Please try again shortly.";
  }

  if (m.includes("ffmpeg")) {
    return "Server video processing failed. Please try again.";
  }

  return null;
}

/* =========================================================
   SPAWN + VERSION CHECK
   ========================================================= */

function spawnCheck(
  cmd,
  args = ["--version"],
  timeoutMs = 10000
) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (result) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };

    let child;

    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return finish({
        available: false,
        version: null,
      });
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill errors
      }

      finish({
        available: false,
        version: null,
        error: "timeout",
      });
    }, timeoutMs);

    child.on("error", () => {
      clearTimeout(timer);

      finish({
        available: false,
        version: null,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      finish({
        available: code === 0,
        version:
          code === 0
            ? ((stdout.trim().split("\n")[0] || "")
                .slice(0, 200) || null)
            : null,
        error:
          code !== 0
            ? (stderr.trim().slice(0, 400) || null)
            : null,
      });
    });
  });
}

/* =========================================================
   YT-DLP RUNTIME FALLBACK DOWNLOAD
   Only used if yt-dlp binary is missing
   ========================================================= */

async function downloadYtDlpBinary() {
  const platform = process.platform;
  const arch = process.arch;

  let assetName;

  if (platform === "linux" && arch === "x64") {
    assetName = "yt-dlp_linux";
  } else if (platform === "linux" && arch === "arm64") {
    assetName = "yt-dlp_linux_aarch64";
  } else {
    throw new Error(
      `Unsupported platform for yt-dlp auto-download: ${platform}/${arch}`
    );
  }

  fs.mkdirSync(YTDLP_BIN_DIR, {
    recursive: true,
  });

  const url =
    `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;

  console.log(
    `[yt-dlp] downloading fallback binary: ${assetName}`
  );

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(
      YTDLP_DOWNLOAD_PATH
    );

    let redirects = 0;

    const go = (requestUrl) => {
      https
        .get(
          requestUrl,
          {
            headers: {
              "User-Agent": "ClipFlow/2.1",
            },
          },
          (res) => {
            if (
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location &&
              redirects < 5
            ) {
              redirects++;

              res.resume();

              return go(res.headers.location);
            }

            if (res.statusCode !== 200) {
              res.resume();

              return reject(
                new Error(`HTTP ${res.statusCode}`)
              );
            }

            res.pipe(file);

            file.on("finish", () => {
              file.close(resolve);
            });

            file.on("error", reject);
            res.on("error", reject);
          }
        )
        .on("error", reject);
    };

    go(url);
  });

  const stat = fs.statSync(
    YTDLP_DOWNLOAD_PATH
  );

  if (stat.size < 500_000) {
    fs.rmSync(YTDLP_DOWNLOAD_PATH, {
      force: true,
    });

    throw new Error(
      "Downloaded yt-dlp binary is too small — likely corrupt"
    );
  }

  fs.chmodSync(
    YTDLP_DOWNLOAD_PATH,
    0o755
  );

  const check = await spawnCheck(
    YTDLP_DOWNLOAD_PATH,
    ["--version"]
  );

  if (!check.available) {
    fs.rmSync(YTDLP_DOWNLOAD_PATH, {
      force: true,
    });

    throw new Error(
      "Downloaded yt-dlp binary is not executable"
    );
  }

  return {
    path: YTDLP_DOWNLOAD_PATH,
    version: check.version,
  };
}

/* =========================================================
   BINARY DISCOVERY
   ========================================================= */

async function getYtDlp() {
  if (cachedYtDlp !== null) {
    return cachedYtDlp;
  }

  // 1) Explicit paths
  for (const p of YTDLP_CANDIDATES) {
    if (!p || !fileExists(p) || !isExecutable(p)) {
      continue;
    }

    const check = await spawnCheck(
      p,
      ["--version"]
    );

    if (check.available) {
      console.log(
        `[yt-dlp] using ${p} (${check.version})`
      );

      cachedYtDlp = {
        path: p,
        version: check.version,
      };

      return cachedYtDlp;
    }
  }

  // 2) PATH lookup
  const pathCheck = await spawnCheck(
    "yt-dlp",
    ["--version"]
  );

  if (pathCheck.available) {
    console.log(
      `[yt-dlp] using PATH (${pathCheck.version})`
    );

    cachedYtDlp = {
      path: "yt-dlp",
      version: pathCheck.version,
    };

    return cachedYtDlp;
  }

  // 3) Runtime fallback download
  try {
    cachedYtDlp = await downloadYtDlpBinary();

    console.log(
      `[yt-dlp] ready (${cachedYtDlp.version})`
    );

    return cachedYtDlp;
  } catch (error) {
    console.error(
      "[yt-dlp] unavailable:",
      error.message
    );

    cachedYtDlp = false;

    return false;
  }
}

async function getFfmpeg() {
  if (cachedFfmpeg !== null) {
    return cachedFfmpeg;
  }

  for (const p of FFMPEG_CANDIDATES) {
    if (!p || !fileExists(p) || !isExecutable(p)) {
      continue;
    }

    const check = await spawnCheck(
      p,
      ["-version"]
    );

    if (check.available) {
      console.log(
        `[ffmpeg] using ${p}`
      );

      cachedFfmpeg = {
        path: p,
      };

      return cachedFfmpeg;
    }
  }

  const pathCheck = await spawnCheck(
    "ffmpeg",
    ["-version"]
  );

  if (pathCheck.available) {
    console.log(
      "[ffmpeg] using PATH"
    );

    cachedFfmpeg = {
      path: "ffmpeg",
    };

    return cachedFfmpeg;
  }

  console.warn(
    "[ffmpeg] NOT AVAILABLE"
  );

  cachedFfmpeg = false;

  return false;
}

/* =========================================================
   JAVASCRIPT RUNTIME SUPPORT
   =========================================================
   Current yt-dlp supports multiple JS runtimes.
   We only enable Node here when the installed Node major
   version is new enough for current yt-dlp requirements.
   ========================================================= */

function getJsRuntimeArgs() {
  const major = Number(
    process.versions.node.split(".")[0]
  );

  if (Number.isFinite(major) && major >= 22) {
    return [
      "--js-runtimes",
      `node:${process.execPath}`,
    ];
  }

  return [];
}

/* =========================================================
   YT-DLP RUNNER
   ========================================================= */

function runYtDlpOnce(
  binPath,
  args,
  timeoutMs = 180000
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binPath,
      args,
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          LC_ALL: process.env.LC_ALL || "C.UTF-8",
        },
        stdio: [
          "ignore",
          "pipe",
          "pipe",
        ],
      }
    );

    let stdout = "";
    let stderr = "";
    let finished = false;

    const finishReject = (error) => {
      if (finished) {
        return;
      }

      finished = true;

      clearTimeout(timer);

      reject(error);
    };

    const finishResolve = (result) => {
      if (finished) {
        return;
      }

      finished = true;

      clearTimeout(timer);

      resolve(result);
    };

    child.stdout.on("data", (data) => {
      stdout += data.toString();

      // Prevent unlimited memory growth
      if (stdout.length > 200_000) {
        stdout = stdout.slice(-200_000);
      }
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();

      // Prevent unlimited memory growth
      if (stderr.length > 200_000) {
        stderr = stderr.slice(-200_000);
      }
    });

    child.on("error", (error) => {
      finishReject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        finishResolve({
          stdout,
          stderr,
        });

        return;
      }

      const message = (
        stderr.trim() ||
        stdout.trim() ||
        `yt-dlp exited with code ${code}`
      ).slice(0, 1500);

      finishReject(
        new Error(message)
      );
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore kill errors
      }

      finishReject(
        new Error(
          "yt-dlp request timed out."
        )
      );
    }, timeoutMs);
  });
}

/* =========================================================
   MAIN YT-DLP FUNCTION
   ========================================================= */

async function runYtDlp(args) {
  const yt = await getYtDlp();

  if (!yt) {
    throw new Error(
      "yt-dlp is not available on this server."
    );
  }

  const jsRuntimeArgs =
    getJsRuntimeArgs();

  const commonArgs = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",

    // Network reliability
    "--retries",
    "3",

    "--fragment-retries",
    "3",

    "--extractor-retries",
    "3",

    "--retry-sleep",
    "linear=1::2",

    "--socket-timeout",
    "30",

    ...jsRuntimeArgs,
  ];

  try {
    return await runYtDlpOnce(
      yt.path,
      [
        ...commonArgs,
        ...args,
      ]
    );
  } catch (error) {
    const message = String(
      error.message || ""
    );

    // Compatibility fallback
    if (
      /unrecognized|unknown option/i.test(
        message
      )
    ) {
      console.warn(
        "[yt-dlp] retrying with compatibility arguments"
      );

      return await runYtDlpOnce(
        yt.path,
        [
          "--no-playlist",
          "--no-warnings",
          "--no-progress",

          "--retries",
          "3",

          "--fragment-retries",
          "3",

          "--extractor-retries",
          "3",

          "--retry-sleep",
          "linear=1::2",

          "--socket-timeout",
          "30",

          ...args,
        ]
      );
    }

    throw error;
  }
}

/* =========================================================
   ROOT ROUTE
   ========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    status: "online",
  });
});

/* =========================================================
   STATUS
   ========================================================= */

app.get("/api/status", async (req, res) => {
  try {
    const [yt, ff] = await Promise.all([
      getYtDlp(),
      getFfmpeg(),
    ]);

    res.json({
      success: true,
      status: "online",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      node: process.version,
      platform:
        `${process.platform}/${process.arch}`,

      ytdlp: yt
        ? {
            available: true,
            path: yt.path,
            version: yt.version,
          }
        : {
            available: false,
            path: null,
            version: null,
          },

      ffmpeg: ff
        ? {
            available: true,
            path: ff.path,
          }
        : {
            available: false,
            path: null,
          },
    });
  } catch (error) {
    console.error(
      "[status] error:",
      error
    );

    res.status(500).json({
      success: false,
      status: "degraded",
      error: "Status check failed.",
    });
  }
});

/* =========================================================
   VIDEO INFO
   ========================================================= */

app.post("/api/info", async (req, res) => {
  try {
    const { url } =
      req.body || {};

    if (!url) {
      return res.status(400).json({
        success: false,
        error:
          "YouTube URL is required.",
      });
    }

    if (!isYouTubeUrl(url)) {
      return res.status(400).json({
        success: false,
        error:
          "Please provide a valid YouTube URL.",
      });
    }

    console.log(
      `[info] ${url}`
    );

    const result =
      await runYtDlp([
        "--dump-single-json",
        "--skip-download",
        url,
      ]);

    let info;

    try {
      info =
        JSON.parse(
          result.stdout
        );
    } catch {
      throw new Error(
        "Could not parse yt-dlp output."
      );
    }

    res.json({
      success: true,

      data: {
        id: info.id || "",

        title:
          info.title ||
          "YouTube Video",

        description:
          info.description ||
          "",

        thumbnail:
          info.thumbnail ||
          (
            info.id
              ? `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`
              : ""
          ),

        duration:
          Number(
            info.duration || 0
          ),

        uploader:
          info.uploader ||
          info.channel ||
          "",

        channel:
          info.channel ||
          info.uploader ||
          "",

        uploadDate:
          info.upload_date ||
          "",

        webpage_url:
          info.webpage_url ||
          url,

        width:
          info.width ||
          null,

        height:
          info.height ||
          null,

        viewCount:
          typeof info.view_count ===
          "number"
            ? info.view_count
            : null,

        likeCount:
          typeof info.like_count ===
          "number"
            ? info.like_count
            : null,
      },
    });
  } catch (error) {
    console.error(
      "[info] error:",
      error.message
    );

    const friendly =
      classifyError(
        error.message
      );

    res.status(500).json({
      success: false,

      error:
        friendly ||
        "Could not fetch video information.",

      details:
        (error.message || "")
          .slice(0, 500),
    });
  }
});

/* =========================================================
   DOWNLOAD
   ========================================================= */

app.post(
  "/api/download",
  async (req, res) => {
    let tempDir = null;

    try {
      const body =
        req.body || {};

      const url =
        body.url;

      const requestedType =
        String(
          body.type ||
            body.format ||
            "video"
        ).toLowerCase();

      const requestedQuality =
        String(
          body.quality ||
            "720"
        );

      const selectedFormat =
        requestedType === "audio"
          ? "audio"
          : "video";

      if (!url) {
        return res.status(400).json({
          success: false,
          error:
            "YouTube URL is required.",
        });
      }

      if (!isYouTubeUrl(url)) {
        return res.status(400).json({
          success: false,
          error:
            "Please provide a valid YouTube URL.",
        });
      }

      const quality =
        ALLOWED_QUALITIES.includes(
          requestedQuality
        )
          ? requestedQuality
          : "720";

      tempDir =
        fs.mkdtempSync(
          path.join(
            os.tmpdir(),
            "clipflow-"
          )
        );

      const outputTemplate =
        path.join(
          tempDir,
          "%(title).150s.%(ext)s"
        );

      const ffmpeg =
        await getFfmpeg();

      let args;

      /* -----------------------------------------------------
         AUDIO
         ----------------------------------------------------- */

      if (
        selectedFormat === "audio"
      ) {
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
          args = [
            "-f",
            "bestaudio/best",

            "-o",
            outputTemplate,

            url,
          ];
        }
      }

      /* -----------------------------------------------------
         VIDEO
         ----------------------------------------------------- */

      else {
        if (ffmpeg) {
          args = [
            "-f",

            `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`,

            "--merge-output-format",
            "mp4",

            "-o",
            outputTemplate,

            url,
          ];
        } else {
          args = [
            "-f",

            `best[height<=${quality}]/best`,

            "-o",
            outputTemplate,

            url,
          ];
        }
      }

      console.log(
        `[download] type=${selectedFormat} quality=${quality} ffmpeg=${Boolean(ffmpeg)} url=${url}`
      );

      await runYtDlp(args);

      const filePath =
        findOutputFile(
          tempDir
        );

      if (!filePath) {
        throw new Error(
          "No output file was produced."
        );
      }

      const ext =
        path.extname(
          filePath
        ).toLowerCase() ||
        ".mp4";

      const base =
        cleanFileName(
          path.basename(
            filePath,
            ext
          )
        );

      const downloadName =
        base +
        (
          selectedFormat ===
            "audio" &&
          ffmpeg
            ? ".mp3"
            : ext
        );

      const stat =
        fs.statSync(
          filePath
        );

      /* -----------------------------------------------------
         RESPONSE HEADERS
         ----------------------------------------------------- */

      res.setHeader(
        "Content-Type",
        detectContentType(
          ext
        )
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

      const stream =
        fs.createReadStream(
          filePath
        );

      let cleaned = false;

      const cleanupOnce =
        () => {
          if (cleaned) {
            return;
          }

          cleaned = true;

          if (tempDir) {
            cleanupDir(
              tempDir
            );

            tempDir =
              null;
          }
        };

      stream.on(
        "error",
        (error) => {
          console.error(
            "[download] stream error:",
            error.message
          );

          cleanupOnce();

          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              error:
                "File read error.",
            });
          } else {
            try {
              res.end();
            } catch {
              // Ignore
            }
          }
        }
      );

      stream.on(
        "close",
        cleanupOnce
      );

      res.on(
        "close",
        cleanupOnce
      );

      stream.pipe(res);
    } catch (error) {
      console.error(
        "[download] error:",
        error.message
      );

      if (tempDir) {
        cleanupDir(
          tempDir
        );

        tempDir = null;
      }

      if (res.headersSent) {
        try {
          res.end();
        } catch {
          // Ignore
        }

        return;
      }

      const friendly =
        classifyError(
          error.message
        );

      res.status(500).json({
        success: false,

        error:
          friendly ||
          "Download failed.",

        details:
          (error.message || "")
            .slice(0, 500),
      });
    }
  }
);

/* =========================================================
   404
   ========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      success: false,
      error:
        "Endpoint not found.",
    });
  }
);

/* =========================================================
   EXPRESS ERROR HANDLER
   ========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "[express] error:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      success: false,
      error:
        "Internal server error.",
    });
  }
);

/* =========================================================
   START SERVER
   ========================================================= */

const server =
  app.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `[server] ClipFlow running on http://${HOST}:${PORT}`
      );

      console.log(
        `[server] Node ${process.version} | ${process.platform}/${process.arch}`
      );

      console.log(
        `[server] NODE_ENV=${
          process.env.NODE_ENV ||
          "development"
        }`
      );
    }
  );

/* =========================================================
   SERVER TIMEOUTS
   ========================================================= */

server.timeout = 0;

server.requestTimeout = 0;

server.headersTimeout =
  120000;

server.keepAliveTimeout =
  65000;

/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */

process.on(
  "SIGTERM",
  () => {
    console.log(
      "[server] SIGTERM received — shutting down gracefully"
    );

    server.close(
      () => {
        process.exit(0);
      }
    );

    setTimeout(
      () => {
        process.exit(0);
      },
      10000
    ).unref();
  }
);

/* =========================================================
   PROCESS ERROR LOGGING
   ========================================================= */

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[server] uncaughtException:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[server] unhandledRejection:",
      reason
    );
  }
);

/* =========================================================
   STARTUP BINARY CHECK
   ========================================================= */

(async () => {
  try {
    const [
      yt,
      ff,
    ] = await Promise.all([
      getYtDlp(),
      getFfmpeg(),
    ]);

    console.log(
      `[startup] yt-dlp : ${
        yt
          ? (
              yt.version ||
              yt.path
            )
          : "NOT AVAILABLE"
      }`
    );

    console.log(
      `[startup] ffmpeg : ${
        ff
          ? ff.path
          : "NOT AVAILABLE"
      }`
    );
  } catch (error) {
    console.error(
      "[startup] binary check failed:",
      error.message
    );
  }
})();
