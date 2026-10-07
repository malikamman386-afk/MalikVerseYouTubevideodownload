const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Frontend local/public folder سے serve ہوگا
app.use(express.static(path.join(__dirname, "public")));

function isYouTubeUrl(url) {
    try {
        const u = new URL(url);
        return (
            ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"].includes(u.hostname)
        );
    } catch {
        return false;
    }
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

// Status
app.get("/api/status", (req, res) => {
    res.json({
        success: true,
        message: "MalikVerse YouTube Downloader is running"
    });
});

// Video information
app.post("/api/info", (req, res) => {
    const { url } = req.body;

    if (!url || !isYouTubeUrl(url)) {
        return res.status(400).json({
            success: false,
            error: "Please enter a valid YouTube URL"
        });
    }

    const args = [
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--no-warnings",
        url
    ];

    const yt = spawn("yt-dlp", args);

    let stdout = "";
    let stderr = "";

    yt.stdout.on("data", data => {
        stdout += data.toString();
    });

    yt.stderr.on("data", data => {
        stderr += data.toString();
    });

    yt.on("error", error => {
        res.status(500).json({
            success: false,
            error: "yt-dlp could not start",
            details: error.message
        });
    });

    yt.on("close", code => {
        if (code !== 0) {
            return res.status(500).json({
                success: false,
                error: "Could not get video information",
                details: stderr.slice(-2000)
            });
        }

        try {
            const info = JSON.parse(stdout);

            res.json({
                success: true,
                title: info.title || "YouTube Video",
                duration: info.duration || 0,
                author: info.uploader || info.channel || "Unknown",
                channel: info.channel || info.uploader || "Unknown",
                quality: info.height || 720
            });
        } catch {
            res.status(500).json({
                success: false,
                error: "Invalid video information received"
            });
        }
    });
});

// Download
app.post("/api/download", (req, res) => {
    const {
        url,
        type = "video",
        quality = "720"
    } = req.body;

    if (!url || !isYouTubeUrl(url)) {
        return res.status(400).json({
            success: false,
            error: "Please enter a valid YouTube URL"
        });
    }

    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "malikverse-")
    );

    const outputTemplate = path.join(
        tempDir,
        "download.%(ext)s"
    );

    let args;

    if (type === "audio") {
        args = [
            "--no-playlist",
            "--no-warnings",
            "-f", "bestaudio",
            "--extract-audio",
            "--audio-format", "mp3",
            "-o", outputTemplate,
            url
        ];
    } else {
        const height = ["360", "720", "1080"].includes(String(quality))
            ? String(quality)
            : "720";

        args = [
            "--no-playlist",
            "--no-warnings",
            "-f",
            `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`,
            "--merge-output-format",
            "mp4",
            "-o",
            outputTemplate,
            url
        ];
    }

    console.log("Starting yt-dlp:", url);

    const yt = spawn("yt-dlp", args);

    let stderr = "";

    yt.stderr.on("data", data => {
        const message = data.toString();
        stderr += message;
        process.stdout.write(message);
    });

    yt.on("error", error => {
        cleanup(tempDir);

        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: "yt-dlp could not start",
                details: error.message
            });
        }
    });

    yt.on("close", code => {
        if (code !== 0) {
            cleanup(tempDir);

            return res.status(500).json({
                success: false,
                error: "Download failed",
                details: stderr.slice(-3000)
            });
        }

        let files;

        try {
            files = fs.readdirSync(tempDir);
        } catch {
            cleanup(tempDir);

            return res.status(500).json({
                success: false,
                error: "Could not read downloaded file"
            });
        }

        const downloadedFile = files.find(file =>
            /\.(mp4|webm|mkv|mp3|m4a|opus)$/i.test(file)
        );

        if (!downloadedFile) {
            cleanup(tempDir);

            return res.status(500).json({
                success: false,
                error: "Downloaded file was not found"
            });
        }

        const filePath = path.join(tempDir, downloadedFile);

        const filename =
            type === "audio"
                ? "MalikVerse-Audio.mp3"
                : "MalikVerse-Video.mp4";

        res.download(filePath, filename, error => {
            cleanup(tempDir);

            if (error) {
                console.error("File send error:", error.message);
            }
        });
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("====================================");
    console.log("   MalikVerse YouTube Downloader");
    console.log("====================================");
    console.log(`Server running on port ${PORT}`);
    console.log("====================================");
});
