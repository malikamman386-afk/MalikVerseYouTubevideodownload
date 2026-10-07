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
const HOST = "0.0.0.0";


// ======================================================
// HELPERS
// ======================================================

function isValidYouTubeUrl(value) {
  try {
    const url = new URL(value);

    const host = url.hostname
      .toLowerCase()
      .replace(/^www\./, "");

    const allowedHosts = [
      "youtube.com",
      "m.youtube.com",
      "youtu.be",
      "youtube-nocookie.com"
    ];

    if (!allowedHosts.includes(host)) {
      return false;
    }

    return true;

  } catch {
    return false;
  }
}


function runYtDlp(args) {
  return new Promise((resolve, reject) => {

    // IMPORTANT:
    // Railway پر yt-dlp کو Python module کے طور پر چلایا جا رہا ہے
    const process = spawn(
      "python",
      ["-m", "yt_dlp", ...args],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", data => {
      stdout += data.toString();
    });

    process.stderr.on("data", data => {
      stderr += data.toString();
    });

    process.on("error", error => {
      reject(error);
    });

    process.on("close", code => {

      if (code === 0) {
        resolve({
          stdout,
          stderr
        });
      } else {
        const error = new Error(
          stderr.trim() ||
          `yt-dlp exited with code ${code}`
        );

        error.code = code;
        error.stderr = stderr;

        reject(error);
      }

    });

  });
}


// ======================================================
// STATUS
// ======================================================

app.get("/api/status", async (req, res) => {

  try {

    const result = await runYtDlp([
      "--version"
    ]);

    res.json({
      success: true,
      status: "online",
      ytDlpVersion: result.stdout.trim()
    });

  } catch (error) {

    res.status(500).json({
      success: false,
      status: "offline",
      error: error.message
    });

  }

});


// ======================================================
// VIDEO INFO
// ======================================================

app.post("/api/info", async (req, res) => {

  const { url } = req.body || {};

  if (!url || !isValidYouTubeUrl(url)) {

    return res.status(400).json({
      success: false,
      error: "Please provide a valid YouTube URL."
    });

  }

  try {

    const result = await runYtDlp([

      "--dump-single-json",

      "--no-playlist",

      "--skip-download",

      "--no-warnings",

      url

    ]);

    const info =
      JSON.parse(result.stdout);

    res.json({

      success: true,

      title:
        info.title || "YouTube Video",

      author:
        info.uploader ||
        info.channel ||
        "",

      channel:
        info.channel ||
        info.uploader ||
        "",

      duration:
        info.duration || null,

      quality:
        info.height
          ? `${info.height}p`
          : null,

      thumbnail:
        info.thumbnail || null,

      id:
        info.id || null

    });

  } catch (error) {

    console.error(
      "INFO ERROR:",
      error
    );

    res.status(500).json({

      success: false,

      error:
        "Could not fetch video information.",

      details:
        error.message

    });

  }

});


// ======================================================
// DOWNLOAD
// ======================================================

app.post("/api/download", async (req, res) => {

  const {
    url,
    type = "video",
    quality = "720"
  } = req.body || {};


  if (!url || !isValidYouTubeUrl(url)) {

    return res.status(400).json({
      success: false,
      error: "Please provide a valid YouTube URL."
    });

  }


  if (
    !["video", "audio"].includes(type)
  ) {

    return res.status(400).json({
      success: false,
      error: "Invalid download type."
    });

  }


  const allowedQualities = [
    "360",
    "720",
    "1080"
  ];

  const selectedQuality =
    allowedQualities.includes(String(quality))
      ? String(quality)
      : "720";


  const tempDir = path.join(
    os.tmpdir(),
    "clipflow-" +
      crypto.randomBytes(8).toString("hex")
  );


  fs.mkdirSync(
    tempDir,
    {
      recursive: true
    }
  );


  try {

    let args = [

      "--no-playlist",

      "--no-warnings",

      "--restrict-filenames",

      "-o",

      path.join(
        tempDir,
        "%(title)s.%(ext)s"
      )

    ];


    // ==================================================
    // VIDEO
    // ==================================================

    if (type === "video") {

      args.push(

        "-f",

        `bestvideo[height<=${selectedQuality}]+bestaudio/best[height<=${selectedQuality}]/best`,

        "--merge-output-format",
        "mp4"

      );

    }


    // ==================================================
    // AUDIO
    // ==================================================

    if (type === "audio") {

      args.push(

        "-f",
        "bestaudio",

        "--extract-audio",

        "--audio-format",
        "mp3",

        "--audio-quality",
        "0"

      );

    }


    args.push(url);


    console.log(
      "Starting yt-dlp..."
    );


    await runYtDlp(args);


    const files =
      fs.readdirSync(tempDir);


    if (!files.length) {

      throw new Error(
        "Download completed but no file was created."
      );

    }


    let outputFile =
      files.find(file =>
        type === "audio"
          ? file.toLowerCase().endsWith(".mp3")
          : file.toLowerCase().endsWith(".mp4")
      );


    if (!outputFile) {

      outputFile =
        files[0];

    }


    const outputPath =
      path.join(
        tempDir,
        outputFile
      );


    if (!fs.existsSync(outputPath)) {

      throw new Error(
        "Downloaded file could not be found."
      );

    }


    const downloadName =
      outputFile;


    res.download(
      outputPath,
      downloadName,
      error => {

        // Cleanup after response
        setTimeout(() => {

          try {

            fs.rmSync(
              tempDir,
              {
                recursive: true,
                force: true
              }
            );

          } catch (cleanupError) {

            console.error(
              "Cleanup error:",
              cleanupError
            );

          }

        }, 5000);


        if (error) {

          console.error(
            "Response download error:",
            error
          );

        }

      }
    );


  } catch (error) {

    console.error(
      "DOWNLOAD ERROR:",
      error
    );


    try {

      fs.rmSync(
        tempDir,
        {
          recursive: true,
          force: true
        }
      );

    } catch {}


    res.status(500).json({

      success: false,

      error:
        "Download failed.",

      details:
        error.message

    });

  }

});


// ======================================================
// BASIC ERROR HANDLER
// ======================================================

app.use(
  (error, req, res, next) => {

    console.error(
      "SERVER ERROR:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({

      success: false,

      error:
        "Internal server error."

    });

  }
);


// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  HOST,
  () => {

    console.log(
      `ClipFlow server running on ${HOST}:${PORT}`
    );

  }
);
