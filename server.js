"use strict";

/* =========================================================
   ClipFlow — YouTube Downloader Backend
   Production-ready for Railway / Docker
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
const SERVICE_VERSION = "2.2.0";

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const INFO_TIMEOUT_MS = 90 * 1000;

const MAX_STDOUT = 400_000;
const MAX_STDERR = 400_000;

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
   APP
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

let cachedYtDlp = null;
let cachedFfmpeg = null;

/* =========================================================
   HELPERS
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

    return new Set([
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "www.youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ]).has(host);
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

  const candidates = files.filter((name) => {
    const lower = name.toLowerCase();

    return (
      !lower.endsWith(".part") &&
      !lower.endsWith(".ytdl") &&
      !lower.endsWith(".temp")
    );
  });

  let best = null;
  let bestSize = -1;

  for (const name of candidates) {
    try {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);

      if (stat.isFile() && stat.size > bestSize) {
        best = fullPath;
        bestSize = stat.size;
      }
    } catch {
      // Ignore files that disappear while scanning.
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
   FRIENDLY ERRORS
   ========================================================= */

function classifyError(message) {
  if (!message) {
    return null;
  }

  const m = String(message).toLowerCase();

  if (
    m.includes("requested format is not available") ||
    m.includes("requested format is unavailable") ||
    m.includes("format is not available")
  ) {
    return "The requested quality is not available for this video.";
  }

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
    m.includes("login required") ||
    m.includes("authentication required") ||
    (m.includes("sign in") && !m.includes("not a bot"))
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
    return "The server is missing yt-dlp.";
  }

  if (m.includes("ffmpeg")) {
    return "Server video processing failed. Please try again.";
  }

  return null;
}

/* =========================================================
   PROCESS CHECK
   ========================================================= */

function spawnCheck(
  cmd,
  args = ["--version"],
  timeoutMs = 10000
) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let child;

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer) {
        clearTimeout(timer);
      }

      resolve(result);
    };

    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({
        available: false,
        version: null,
      });

      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore.
      }

      finish({
        available: false,
        version: null,
        error: "timeout",
      });
    }, timeoutMs);

    child.on("error", () => {
      finish({
        available: false,
        version: null,
      });
    });

    child.on("close", (code) => {
      finish({
        available: code === 0,

        version:
          code === 0
            ? (stdout.trim().split("\n")[0] || "")
                .slice(0, 200) || null
            : null,

        error:
          code !== 0
            ? stderr.trim().slice(0, 400) || null
            : null,
      });
    });
  });
}

/* =========================================================
   YT-DLP FALLBACK DOWNLOAD
   ========================================================= */

async function downloadYtDlpBinary() {
  if (process.platform !== "linux") {
    throw new Error(
      "Automatic yt-dlp install is supported on Linux only."
    );
  }

  let assetName;

  if (process.arch === "x64") {
    assetName = "yt-dlp_linux";
  } else if (process.arch === "arm64") {
    assetName = "yt-dlp_linux_aarch64";
  } else {
    throw new Error(
      `Unsupported Linux architecture for yt-dlp: ${process.arch}`
    );
  }

  fs.mkdirSync(
    YTDLP_BIN_DIR,
    {
      recursive: true,
    }
  );

  const url =
    `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`;

  console.log(
    `[yt-dlp] downloading fallback binary: ${assetName}`
  );

  await new Promise((resolve, reject) => {
    const file =
      fs.createWriteStream(
        YTDLP_DOWNLOAD_PATH
      );

    let redirects = 0;

    const request = (requestUrl) => {
      const req = https.get(
        requestUrl,
        {
          headers: {
            "User-Agent":
              "ClipFlow/2.2",
          },
        },
        (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location &&
            redirects < 5
          ) {
            redirects += 1;

            response.resume();

            request(
              response.headers.location
            );

            return;
          }

          if (response.statusCode !== 200) {
            response.resume();

            reject(
              new Error(
                `HTTP ${response.statusCode}`
              )
            );

            return;
          }

          response.pipe(file);

          file.on(
            "finish",
            () => file.close(resolve)
          );

          file.on(
            "error",
            reject
          );

          response.on(
            "error",
            reject
          );
        }
      );

      req.on(
        "error",
        reject
      );
    };

    request(url);
  });

  const stat =
    fs.statSync(
      YTDLP_DOWNLOAD_PATH
    );

  if (stat.size < 500_000) {
    fs.rmSync(
      YTDLP_DOWNLOAD_PATH,
      {
        force: true,
      }
    );

    throw new Error(
      "Downloaded yt-dlp binary looks corrupt."
    );
  }

  fs.chmodSync(
    YTDLP_DOWNLOAD_PATH,
    0o755
  );

  const check =
    await spawnCheck(
      YTDLP_DOWNLOAD_PATH,
      ["--version"]
    );

  if (!check.available) {
    fs.rmSync(
      YTDLP_DOWNLOAD_PATH,
      {
        force: true,
      }
    );

    throw new Error(
      "Downloaded yt-dlp binary is not executable."
    );
  }

  return {
    path:
      YTDLP_DOWNLOAD_PATH,

    version:
      check.version,
  };
}

/* =========================================================
   BINARY DISCOVERY
   ========================================================= */

async function getYtDlp() {
  if (cachedYtDlp !== null) {
    return cachedYtDlp;
  }

  for (
    const candidate of YTDLP_CANDIDATES
  ) {
    if (
      !candidate ||
      !fileExists(candidate) ||
      !isExecutable(candidate)
    ) {
      continue;
    }

    const check =
      await spawnCheck(
        candidate,
        ["--version"]
      );

    if (check.available) {
      cachedYtDlp = {
        path: candidate,
        version: check.version,
      };

      console.log(
        `[yt-dlp] using ${candidate} (${check.version})`
      );

      return cachedYtDlp;
    }
  }

  const pathCheck =
    await spawnCheck(
      "yt-dlp",
      ["--version"]
    );

  if (pathCheck.available) {
    cachedYtDlp = {
      path: "yt-dlp",
      version: pathCheck.version,
    };

    console.log(
      `[yt-dlp] using PATH (${pathCheck.version})`
    );

    return cachedYtDlp;
  }

  try {
    cachedYtDlp =
      await downloadYtDlpBinary();

    console.log(
      `[yt-dlp] downloaded fallback (${cachedYtDlp.version})`
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

  for (
    const candidate of FFMPEG_CANDIDATES
  ) {
    if (
      !candidate ||
      !fileExists(candidate) ||
      !isExecutable(candidate)
    ) {
      continue;
    }

    const check =
      await spawnCheck(
        candidate,
        ["-version"]
      );

    if (check.available) {
      cachedFfmpeg = {
        path: candidate,
      };

      console.log(
        `[ffmpeg] using ${candidate}`
      );

      return cachedFfmpeg;
    }
  }

  const pathCheck =
    await spawnCheck(
      "ffmpeg",
      ["-version"]
    );

  if (pathCheck.available) {
    cachedFfmpeg = {
      path: "ffmpeg",
    };

    console.log(
      "[ffmpeg] using PATH"
    );

    return cachedFfmpeg;
  }

  cachedFfmpeg = false;

  console.warn(
    "[ffmpeg] NOT AVAILABLE"
  );

  return false;
}

/* =========================================================
   JAVASCRIPT RUNTIME SUPPORT
   ========================================================= */

function getJsRuntimeArgs() {
  const major =
    Number(
      process.versions.node.split(".")[0]
    );

  if (
    Number.isFinite(major) &&
    major >= 22
  ) {
    return [
      "--js-runtimes",
      `node:${process.execPath}`,
    ];
  }

  return [];
}

/* =========================================================
   YT-DLP EXECUTION
   ========================================================= */

function runYtDlpOnce(
  binPath,
  args,
  timeoutMs
) {
  return new Promise(
    (resolve, reject) => {
      let finished = false;
      let timer = null;
      let child;

      const finishReject =
        (error) => {
          if (finished) {
            return;
          }

          finished = true;

          if (timer) {
            clearTimeout(timer);
          }

          reject(error);
        };

      const finishResolve =
        (result) => {
          if (finished) {
            return;
          }

          finished = true;

          if (timer) {
            clearTimeout(timer);
          }

          resolve(result);
        };

      try {
        child = spawn(
          binPath,
          args,
          {
            cwd:
              process.cwd(),

            env: {
              ...process.env,

              PYTHONUNBUFFERED:
                "1",

              LC_ALL:
                process.env.LC_ALL ||
                "C.UTF-8",
            },

            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
          }
        );
      } catch (error) {
        finishReject(error);
        return;
      }

      let stdout = "";
      let stderr = "";

      child.stdout?.on(
        "data",
        (data) => {
          stdout +=
            data.toString();

          if (
            stdout.length >
            MAX_STDOUT
          ) {
            stdout =
              stdout.slice(
                -MAX_STDOUT
              );
          }
        }
      );

      child.stderr?.on(
        "data",
        (data) => {
          stderr +=
            data.toString();

          if (
            stderr.length >
            MAX_STDERR
          ) {
            stderr =
              stderr.slice(
                -MAX_STDERR
              );
          }
        }
      );

      child.on(
        "error",
        finishReject
      );

      child.on(
        "close",
        (code) => {
          if (code === 0) {
            finishResolve({
              stdout,
              stderr,
            });

            return;
          }

          const message =
            (
              stderr.trim() ||
              stdout.trim() ||
              `yt-dlp exited with code ${code}`
            ).slice(
              0,
              3000
            );

          finishReject(
            new Error(
              message
            )
          );
        }
      );

      timer =
        setTimeout(
          () => {
            try {
              child.kill(
                "SIGKILL"
              );
            } catch {
              // Ignore.
            }

            finishReject(
              new Error(
                "yt-dlp request timed out."
              )
            );
          },
          timeoutMs
        );
    }
  );
}

function isCompatibilityError(
  message
) {
  return /unrecognized|unknown option/i.test(
    message
  );
}

async function runYtDlp(
  args,
  options = {}
) {
  const yt =
    await getYtDlp();

  if (!yt) {
    throw new Error(
      "yt-dlp is not available on this server."
    );
  }

  const timeoutMs =
    Number(
      options.timeoutMs
    ) ||
    DOWNLOAD_TIMEOUT_MS;

  const jsArgs =
    getJsRuntimeArgs();

  const commonArgs = [
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

    ...jsArgs,
  ];

  try {
    return await runYtDlpOnce(
      yt.path,

      [
        ...commonArgs,
        ...args,
      ],

      timeoutMs
    );
  } catch (error) {
    const message =
      String(
        error.message ||
          ""
      );

    if (
      isCompatibilityError(
        message
      ) &&
      jsArgs.length
    ) {
      console.warn(
        "[yt-dlp] compatibility retry without JS runtime args"
      );

      return runYtDlpOnce(
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
        ],

        timeoutMs
      );
    }

    throw error;
  }
}

/* =========================================================
   FORMAT BUILDERS
   ========================================================= */

function buildVideoFormat(
  quality
) {
  /*
     1. Best video up to requested height + best audio
     2. Best combined A/V up to requested height
     3. Best video + best audio without height restriction
     4. Best single combined format

     This gives yt-dlp several valid choices instead of
     failing when one exact quality does not exist.
  */

  return [
    `bv*[height<=${quality}]+ba`,
    `b[height<=${quality}]`,
    "bv*+ba",
    "b",
  ].join("/");
}

function buildAudioFormat() {
  return "ba/b";
}

/* =========================================================
   ROOT
   ========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      success: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      status: "online",
    });
  }
);

/* =========================================================
   STATUS
   ========================================================= */

app.get(
  "/api/status",
  async (req, res) => {
    try {
      const [
        yt,
        ff,
      ] =
        await Promise.all([
          getYtDlp(),
          getFfmpeg(),
        ]);

      res.json({
        success: true,

        status:
          "online",

        service:
          SERVICE_NAME,

        version:
          SERVICE_VERSION,

        node:
          process.version,

        platform:
          `${process.platform}/${process.arch}`,

        ytdlp: yt
          ? {
              available:
                true,

              path:
                yt.path,

              version:
                yt.version,
            }
          : {
              available:
                false,

              path:
                null,

              version:
                null,
            },

        ffmpeg: ff
          ? {
              available:
                true,

              path:
                ff.path,
            }
          : {
              available:
                false,

              path:
                null,
            },
      });
    } catch (error) {
      console.error(
        "[status] error:",
        error
      );

      res.status(500).json({
        success:
          false,

        status:
          "degraded",

        error:
          "Status check failed.",
      });
    }
  }
);

/* =========================================================
   VIDEO INFO
   ========================================================= */

app.post(
  "/api/info",
  async (req, res) => {
    try {
      const {
        url,
      } =
        req.body ||
        {};

      if (!url) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "YouTube URL is required.",
          });
      }

      if (!isYouTubeUrl(url)) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Please provide a valid YouTube URL.",
          });
      }

      console.log(
        `[info] ${url}`
      );

      const result =
        await runYtDlp(
          [
            "--dump-single-json",
            "--skip-download",
            url,
          ],
          {
            timeoutMs:
              INFO_TIMEOUT_MS,
          }
        );

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
        success:
          true,

        data: {
          id:
            info.id ||
            "",

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
              info.duration ||
                0
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

      res.status(500).json({
        success:
          false,

        error:
          classifyError(
            error.message
          ) ||
          "Could not fetch video information.",

        details:
          String(
            error.message ||
              ""
          ).slice(
            0,
            600
          ),
      });
    }
  }
);

/* =========================================================
   DOWNLOAD
   ========================================================= */

app.post(
  "/api/download",
  async (req, res) => {
    let tempDir =
      null;

    try {
      const body =
        req.body ||
        {};

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

      if (!url) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "YouTube URL is required.",
          });
      }

      if (!isYouTubeUrl(url)) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Please provide a valid YouTube URL.",
          });
      }

      const selectedType =
        requestedType ===
        "audio"
          ? "audio"
          : "video";

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
        selectedType ===
        "audio"
      ) {
        if (!ffmpeg) {
          throw new Error(
            "FFmpeg is required for MP3 downloads."
          );
        }

        args = [
          "-f",
          buildAudioFormat(),

          "--extract-audio",

          "--audio-format",
          "mp3",

          "--audio-quality",
          "0",

          "-o",
          outputTemplate,

          url,
        ];
      }

      /* -----------------------------------------------------
         VIDEO WITH FFMPEG
         ----------------------------------------------------- */

      else if (ffmpeg) {
        args = [
          "-f",
          buildVideoFormat(
            quality
          ),

          "--merge-output-format",
          "mp4",

          "-o",
          outputTemplate,

          url,
        ];
      }

      /* -----------------------------------------------------
         VIDEO WITHOUT FFMPEG
         ----------------------------------------------------- */

      else {
        args = [
          "-f",
          `b[height<=${quality}]/b`,

          "-o",
          outputTemplate,

          url,
        ];
      }

      console.log(
        `[download] type=${selectedType} quality=${quality} ffmpeg=${Boolean(
          ffmpeg
        )} url=${url}`
      );

      /* -----------------------------------------------------
         FIRST DOWNLOAD ATTEMPT
         ----------------------------------------------------- */

      try {
        await runYtDlp(
          args,
          {
            timeoutMs:
              DOWNLOAD_TIMEOUT_MS,
          }
        );
      } catch (firstError) {
        const firstMessage =
          String(
            firstError.message ||
              ""
          );

        /* ---------------------------------------------------
           SECOND FORMAT FALLBACK

           If the selected quality combination is unavailable,
           request the best available video/audio combination.
           --------------------------------------------------- */

        if (
          selectedType ===
            "video" &&
          ffmpeg &&
          /requested format is not available|format is not available|requested format is unavailable/i.test(
            firstMessage
          )
        ) {
          console.warn(
            "[download] requested format unavailable — using best available fallback"
          );

          await runYtDlp(
            [
              "-f",
              "bv*+ba/b",

              "--merge-output-format",
              "mp4",

              "-o",
              outputTemplate,

              url,
            ],
            {
              timeoutMs:
                DOWNLOAD_TIMEOUT_MS,
            }
          );
        } else {
          throw firstError;
        }
      }

      /* -----------------------------------------------------
         FIND OUTPUT
         ----------------------------------------------------- */

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
        selectedType ===
          "audio" &&
        ffmpeg
          ? `${base}.mp3`
          : `${base}${ext}`;

      const stat =
        fs.statSync(
          filePath
        );

      /* -----------------------------------------------------
         RESPONSE
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

      let cleaned =
        false;

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

          if (
            !res.headersSent
          ) {
            res
              .status(500)
              .json({
                success:
                  false,

                error:
                  "File read error.",
              });
          } else {
            try {
              res.end();
            } catch {
              // Ignore.
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

        tempDir =
          null;
      }

      if (
        res.headersSent
      ) {
        try {
          res.end();
        } catch {
          // Ignore.
        }

        return;
      }

      res
        .status(500)
        .json({
          success:
            false,

          error:
            classifyError(
              error.message
            ) ||
            "Download failed.",

          details:
            String(
              error.message ||
                ""
            ).slice(
              0,
              600
            ),
        });
    }
  }
);

/* =========================================================
   404
   ========================================================= */

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        success:
          false,

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

    if (
      res.headersSent
    ) {
      next(error);
      return;
    }

    res
      .status(500)
      .json({
        success:
          false,

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
        `[server] ${SERVICE_NAME} ${SERVICE_VERSION}`
      );

      console.log(
        `[server] listening on http://${HOST}:${PORT}`
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

server.timeout =
  0;

server.requestTimeout =
  0;

server.headersTimeout =
  120000;

server.keepAliveTimeout =
  65000;

/* =========================================================
   GRACEFUL SHUTDOWN
   ========================================================= */

function shutdown(
  signal
) {
  console.log(
    `[server] ${signal} received — shutting down`
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

process.on(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
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
   STARTUP CHECKS
   ========================================================= */

(async () => {
  try {
    const [
      yt,
      ff,
    ] =
      await Promise.all([
        getYtDlp(),
        getFfmpeg(),
      ]);

    console.log(
      `[startup] yt-dlp: ${
        yt
          ? yt.version ||
            yt.path
          : "NOT AVAILABLE"
      }`
    );

    console.log(
      `[startup] ffmpeg: ${
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
