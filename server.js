'use strict';

/**
 * ClipFlow / MalikVerse YouTube Downloader backend.
 *
 * Endpoints (contract unchanged):
 *   GET  /api/status    -> tool availability and server health
 *   POST /api/info      -> { url }                      -> video metadata
 *   POST /api/download  -> { url, quality, type }       -> streamed file
 *
 * Required binaries (installed by the Dockerfile):
 *   yt-dlp, ffmpeg, deno (JavaScript runtime for YouTube challenge solving)
 *
 * Nothing is executed through a shell. Every process is started with spawn()
 * and an argument array.
 */

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number.parseInt(process.env.PORT, 10) || 8080;
const HOST = '0.0.0.0';

const YT_DLP_BIN = process.env.YT_DLP_BIN || 'yt-dlp';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const DENO_BIN = process.env.DENO_BIN || 'deno';

const MAX_CONCURRENT_DOWNLOADS = clampInt(process.env.MAX_CONCURRENT_DOWNLOADS, 2, 1, 4);
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 3000;

const TOOL_CACHE_MS = 5 * 60 * 1000;
const TOOL_PROBE_TIMEOUT_MS = 20 * 1000;
const INFO_TIMEOUT_MS = 90 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DOWNLOAD_FILESIZE = '2G';

const TEMP_PREFIX = 'clipflow-';
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;
const TEMP_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_REQUEST_BODY = '32kb';

const INVALID_URL_MESSAGE = 'Please enter a valid YouTube video link.';
const YTDLP_UNAVAILABLE_MESSAGE =
  'The downloader (yt-dlp) is unavailable on this server. Please try again later.';
const BUSY_MESSAGE = 'The server is busy with other downloads. Please try again in a moment.';

const POT_PROVIDER_URL = process.env.YTDLP_POT_PROVIDER_URL || '';
const POT_URL_RE = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;
const POT_PROVIDER_CONFIGURED = POT_PROVIDER_URL !== '' && POT_URL_RE.test(POT_PROVIDER_URL);

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.opus', '.ogg', '.aac', '.mka', '.webm']);

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.mka': 'audio/x-matroska',
};

// First match wins. Specific patterns come before generic ones.
// `retryable` is true only for transient failures. Permanent failures
// (private, age-restricted, unavailable, verification, rate limit) are never retried.
const ERROR_RULES = [
  {
    pattern: /requested format is not available|no video formats found/i,
    status: 422,
    retryable: false,
    message: 'The requested quality is not available for this video. Try a different quality.',
  },
  {
    pattern: /sign in to confirm you(?:'|\u2019)?re not a bot|confirm you(?:'|\u2019)?re not a bot/i,
    status: 403,
    retryable: false,
    message:
      'YouTube is asking this server to verify it is not a bot. Downloads from this server are blocked for now. Try again later.',
  },
  {
    pattern: /confirm your age|age[- ]restricted|sign in to confirm your age/i,
    status: 403,
    retryable: false,
    message: 'This video is age-restricted and cannot be downloaded.',
  },
  {
    pattern: /private video/i,
    status: 403,
    retryable: false,
    message: 'This video is private.',
  },
  {
    pattern: /members[- ]only|join this channel/i,
    status: 403,
    retryable: false,
    message: 'This video is for channel members only and cannot be downloaded.',
  },
  {
    pattern: /in your country|geo[- ]?restrict|geoblock|not made this video available/i,
    status: 451,
    retryable: false,
    message: 'This video is restricted in the server region.',
  },
  {
    pattern: /n challenge solving failed|signature solving failed|js challenge/i,
    status: 502,
    retryable: false,
    message:
      'YouTube challenge solving failed on the server. The JavaScript runtime or yt-dlp needs an update.',
  },
  {
    pattern: /video (?:is )?unavailable|this video is not available|video has been removed|removed by the uploader|account (?:has been )?terminated/i,
    status: 404,
    retryable: false,
    message:
      'This video is unavailable, or YouTube did not return it to this server. Check that the link opens in a browser.',
  },
  {
    pattern: /ffmpeg.*(?:not (?:installed|found|available)|no such file)/i,
    status: 500,
    retryable: false,
    message: 'FFmpeg is unavailable on this server, so this request cannot be completed.',
  },
  {
    pattern: /HTTP Error 429|too many requests/i,
    status: 429,
    retryable: false,
    message: 'YouTube is rate-limiting this server. Please wait before trying again.',
  },
  {
    pattern: /HTTP Error 403|forbidden/i,
    status: 403,
    retryable: false,
    message: 'YouTube refused the request (HTTP 403). Try again later.',
  },
  {
    pattern: /timed out|timeout/i,
    status: 504,
    retryable: true,
    message: 'The request timed out. Please try again.',
  },
  {
    pattern: /HTTP Error 5\d\d|unable to download video data|unable to download webpage|connection reset|network is unreachable|temporary failure|incomplete read/i,
    status: 502,
    retryable: true,
    message: 'A network error occurred while downloading. Please try again.',
  },
  {
    pattern: /unable to extract|could not parse/i,
    status: 502,
    retryable: true,
    message: 'Could not read video information from YouTube. Please try again.',
  },
];

// ---------------------------------------------------------------------------
// Application setup
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: MAX_REQUEST_BODY }));

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let toolState = emptyToolState();
const activeChildren = new Set();
let activeDownloads = 0;

function emptyToolState() {
  return {
    checkedAt: 0,
    ytDlp: { available: false, path: null, version: null },
    ffmpeg: { available: false, path: null, version: null },
    deno: { available: false, path: null, version: null },
  };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch (_error) {
      // Already exited.
    }
  }
}

/**
 * Runs a command without a shell.
 * Always resolves (never rejects) with { code, signal, stdout, stderr, timedOut, error }.
 */
function runProcess(bin, args, options = {}) {
  const { timeoutMs = 0, onSpawn } = options;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error });
      return;
    }

    activeChildren.add(child);
    if (onSpawn) onSpawn(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killChild(child);
          }, timeoutMs)
        : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk;
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activeChildren.delete(child);
      resolve({ ...result, stdout, stderr, timedOut });
    };

    child.on('error', (error) => finish({ code: null, signal: null, error }));
    child.on('close', (code, signal) => finish({ code, signal, error: null }));
  });
}

/** Finds an executable on PATH (or checks an absolute path) without using a shell. */
async function resolveBinary(bin) {
  if (bin.includes('/')) {
    try {
      await fs.promises.access(bin, fs.constants.X_OK);
      return bin;
    } catch (_error) {
      return null;
    }
  }

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_error) {
      // Try the next directory.
    }
  }
  return null;
}

async function probeVersion(binPath, args) {
  const result = await runProcess(binPath, args, { timeoutMs: TOOL_PROBE_TIMEOUT_MS });
  if (result.error || result.timedOut || result.code !== 0) return null;
  const firstLine = result.stdout.trim().split('\n')[0] || result.stderr.trim().split('\n')[0] || '';
  return firstLine.trim() || 'unknown';
}

async function detectTools(force = false) {
  if (!force && Date.now() - toolState.checkedAt < TOOL_CACHE_MS) {
    return toolState;
  }

  const [ytdlpPath, ffmpegPath, denoPath] = await Promise.all([
    resolveBinary(YT_DLP_BIN),
    resolveBinary(FFMPEG_BIN),
    resolveBinary(DENO_BIN),
  ]);

  const [ytdlpVersion, ffmpegVersion, denoVersion] = await Promise.all([
    ytdlpPath ? probeVersion(ytdlpPath, ['--version']) : null,
    ffmpegPath ? probeVersion(ffmpegPath, ['-version']) : null,
    denoPath ? probeVersion(denoPath, ['--version']) : null,
  ]);

  toolState = {
    checkedAt: Date.now(),
    ytDlp: { available: Boolean(ytdlpVersion), path: ytdlpPath, version: ytdlpVersion },
    ffmpeg: { available: Boolean(ffmpegVersion), path: ffmpegPath, version: ffmpegVersion },
    deno: { available: Boolean(denoVersion), path: denoPath, version: denoVersion },
  };

  return toolState;
}

// ---------------------------------------------------------------------------
// URL and option handling
// ---------------------------------------------------------------------------

function extractVideoId(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch (_error) {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;

  let id = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] || null;
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    if (match) id = match[1];
  }

  return id && VIDEO_ID_RE.test(id) ? id : null;
}

function buildWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Returns a height cap in pixels, or 0 for "best available". Unknown values mean best. */
function parseQuality(value) {
  if (value === undefined || value === null) return 0;
  const str = String(value).trim().toLowerCase();
  if (str === '' || str === 'best' || str === 'auto' || str === 'max') return 0;

  const match = str.match(/^(\d{3,4})p?$/);
  if (!match) return 0;

  const height = Number.parseInt(match[1], 10);
  if (height < 144 || height > 4320) return 0;
  return height;
}

function isAudioRequest(body) {
  if (body.audioOnly === true) return true;
  const type = String(body.type ?? body.format ?? '').trim().toLowerCase();
  return type === 'mp3' || type === 'audio' || type === 'm4a';
}

// ---------------------------------------------------------------------------
// yt-dlp argument construction (argument arrays only)
// ---------------------------------------------------------------------------

/**
 * Video selector using yt-dlp's documented "/" fallback operator.
 *
 * With FFmpeg:
 *   1. best MP4 video <= H merged with M4A audio
 *   2. best video <= H merged with best audio
 *   3. best single pre-merged format <= H
 *   4. best video merged with best audio, with no height cap
 *   5. best single pre-merged format, with no cap
 *
 * Without FFmpeg:
 *   Only single pre-merged formats (`b`). A separate video or audio stream is
 *   never selected, because yt-dlp could not merge it.
 */
function buildVideoSelector(height, ffmpegAvailable) {
  if (!ffmpegAvailable) {
    return height > 0 ? `b[height<=${height}]/b` : 'b';
  }

  if (height > 0) {
    return [
      `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]`,
      `bv*[height<=${height}]+ba`,
      `b[height<=${height}]`,
      'bv*+ba',
      'b',
    ].join('/');
  }

  return 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b';
}

function buildCommonArgs(tools) {
  const args = [
    '--no-config',
    '--no-cache-dir',
    '--no-playlist',
    '--no-progress',
    '--no-color',
    '--socket-timeout', '20',
    '--retries', '3',
    '--fragment-retries', '5',
    '--extractor-retries', '2',
    '--file-access-retries', '3',
  ];

  if (tools.deno.available && tools.deno.path) {
    args.push('--js-runtimes', `deno:${tools.deno.path}`);
  }

  // Optional PO Token provider (bgutil HTTP provider). No cookies or credentials are used.
  if (POT_PROVIDER_CONFIGURED) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`);
  }

  return args;
}

function buildInfoArgs(videoId, tools) {
  return [...buildCommonArgs(tools), '--dump-single-json', '--skip-download', '--', buildWatchUrl(videoId)];
}

function buildDownloadArgs({ videoId, kind, height, tools, outputDir }) {
  const args = [
    ...buildCommonArgs(tools),
    '--max-filesize', MAX_DOWNLOAD_FILESIZE,
    '-P', outputDir,
    '-o', '%(title).100B [%(id)s].%(ext)s',
  ];

  if (kind === 'audio') {
    if (tools.ffmpeg.available) {
      args.push('-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      // No conversion is possible, so deliver the best native audio stream as-is.
      args.push('-f', 'ba/b');
    }
  } else {
    args.push('-f', buildVideoSelector(height, tools.ffmpeg.available));
    if (tools.ffmpeg.available) {
      args.push('--merge-output-format', 'mp4');
    }
  }

  args.push('--', buildWatchUrl(videoId));
  return args;
}

// ---------------------------------------------------------------------------
// Output parsing and error mapping
// ---------------------------------------------------------------------------

/**
 * Parses yt-dlp JSON from stdout. Tries the whole output, then the outermost
 * {...} block, then the last line that looks like a JSON object.
 */
function parseJsonOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    // Fall through.
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_error) {
      // Fall through.
    }
  }

  const lines = trimmed.split('\n').reverse();
  for (const line of lines) {
    const candidate = line.trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      try {
        return JSON.parse(candidate);
      } catch (_error) {
        // Keep looking.
      }
    }
  }

  return null;
}

function toInfoResponse(data, videoId) {
  return {
    id: data.id || videoId,
    title: data.title || 'Untitled video',
    thumbnail: data.thumbnail || null,
    duration: typeof data.duration === 'number' ? data.duration : null,
    uploader: data.uploader || data.channel || null,
    channel: data.channel || data.uploader || null,
    webpage_url: data.webpage_url || buildWatchUrl(videoId),
  };
}

/** Returns a mapped error for known yt-dlp messages, or null when nothing matches. */
function classifyYtDlpError(output) {
  const text = String(output || '');
  for (const rule of ERROR_RULES) {
    if (rule.pattern.test(text)) {
      return { status: rule.status, message: rule.message, retryable: rule.retryable };
    }
  }
  return null;
}

/** Turns a finished child process into a failure description for the client. */
function describeFailure(result, context) {
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return {
        status: 503,
        message: YTDLP_UNAVAILABLE_MESSAGE,
        retryable: false,
        log: `${context}: executable not found (${result.error.message})`,
      };
    }
    return {
      status: 500,
      message: 'The download service failed to start. Please try again later.',
      retryable: false,
      log: `${context}: spawn error (${result.error.message})`,
    };
  }

  if (result.timedOut) {
    return {
      status: 504,
      message: 'The request timed out. Please try again.',
      retryable: true,
      log: `${context}: killed after timeout`,
    };
  }

  const classified = classifyYtDlpError(result.stderr || result.stdout);
  const log = `${context}: exit=${result.code} signal=${result.signal} stderr=${truncate(result.stderr, 2000)}`;

  if (classified) return { ...classified, log };

  return {
    status: 500,
    message: 'The download failed. Please try again.',
    retryable: false,
    log,
  };
}

function sendError(res, status, message) {
  if (res.headersSent) return;
  res.status(status).json({ ok: false, error: message });
}

function sendFailure(res, failure) {
  if (failure && failure.log) {
    console.error(`[failure] ${failure.log}`);
  }
  sendError(
    res,
    failure ? failure.status : 500,
    failure ? failure.message : 'The download failed. Please try again.'
  );
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------

function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned || 'clipflow-download';
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

/**
 * Finds the finished output file in a directory. Partial, intermediate, and
 * temporary files are skipped. If several candidates exist, the newest wins,
 * because merging and conversion write the final file last.
 */
async function findOutputFile(dir, kind) {
  const allowedExts = kind === 'audio' ? AUDIO_EXTS : VIDEO_EXTS;
  const entries = await fs.promises.readdir(dir);
  let best = null;

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (/\.(?:part|ytdl|temp|tmp)$/i.test(name)) continue;
    if (/\.part-frag\d+$/i.test(name)) continue;
    if (/\.f\d+\./i.test(name)) continue; // separate stream intermediates, e.g. "x.f137.mp4"

    const ext = path.extname(name).toLowerCase();
    if (!allowedExts.has(ext)) continue;

    const fullPath = path.join(dir, name);
    let stat;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch (_error) {
      continue;
    }

    if (!stat.isFile() || stat.size === 0) continue;

    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { path: fullPath, name, ext, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }

  return best;
}

/** Checks the first bytes of a file for an MP3 header (ID3 tag or MPEG frame sync). */
async function looksLikeMp3(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(3);
    const { bytesRead } = await handle.read(buffer, 0, 3, 0);
    if (bytesRead < 2) return false;
    if (buffer.toString('ascii', 0, 3) === 'ID3') return true;
    return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
  } finally {
    await handle.close();
  }
}

async function removeDir(dir) {
  if (!dir) return;
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[cleanup] failed to remove ${dir}: ${error.message}`);
  }
}

async function sweepStaleTempDirs() {
  try {
    const root = os.tmpdir();
    const entries = await fs.promises.readdir(root);
    const now = Date.now();

    await Promise.all(
      entries
        .filter((name) => name.startsWith(TEMP_PREFIX))
        .map(async (name) => {
          const fullPath = path.join(root, name);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (now - stat.mtimeMs > STALE_TEMP_AGE_MS) {
              await removeDir(fullPath);
            }
          } catch (_error) {
            // Entry disappeared during the sweep.
          }
        })
    );
  } catch (error) {
    console.warn(`[cleanup] temp sweep failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

function tryAcquireSlot() {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) return false;
  activeDownloads += 1;
  return true;
}

function releaseSlot() {
  activeDownloads = Math.max(0, activeDownloads - 1);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/status', async (_req, res) => {
  const tools = await detectTools();
  res.json({
    ok: true,
    status: 'running',
    ytDlp: {
      available: tools.ytDlp.available,
      version: tools.ytDlp.version,
      path: tools.ytDlp.path,
    },
    ffmpeg: {
      available: tools.ffmpeg.available,
      version: tools.ffmpeg.version,
      path: tools.ffmpeg.path,
    },
    deno: {
      available: tools.deno.available,
      version: tools.deno.version,
      path: tools.deno.path,
    },
    potProvider: {
      configured: POT_PROVIDER_CONFIGURED,
    },
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    activeDownloads,
    maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.post('/api/info', async (req, res) => {
  const body = req.body || {};
  const videoId = extractVideoId(body.url);
  if (!videoId) {
    sendError(res, 400, INVALID_URL_MESSAGE);
    return;
  }

  try {
    const tools = await detectTools();
    if (!tools.ytDlp.available || !tools.ytDlp.path) {
      sendError(res, 503, YTDLP_UNAVAILABLE_MESSAGE);
      return;
    }

    const result = await runProcess(tools.ytDlp.path, buildInfoArgs(videoId, tools), {
      timeoutMs: INFO_TIMEOUT_MS,
    });

    if (result.error || result.timedOut || result.code !== 0) {
      sendFailure(res, describeFailure(result, 'info'));
      return;
    }

    const data = parseJsonOutput(result.stdout);
    if (!data) {
      const classified = classifyYtDlpError(result.stderr);
      const log = `info: unparseable output. stdout=${truncate(result.stdout, 500)} stderr=${truncate(result.stderr, 1000)}`;
      if (classified) {
        sendFailure(res, { ...classified, log });
      } else {
        sendFailure(res, {
          status: 502,
          message: 'Could not read video information. Please try again.',
          retryable: true,
          log,
        });
      }
      return;
    }

    res.json({ ok: true, ...toInfoResponse(data, videoId) });
  } catch (error) {
    console.error('[info] unexpected error:', error);
    sendError(res, 500, 'Unexpected server error. Please try again.');
  }
});

app.post('/api/download', async (req, res) => {
  const body = req.body || {};
  const videoId = extractVideoId(body.url);
  if (!videoId) {
    sendError(res, 400, INVALID_URL_MESSAGE);
    return;
  }

  const kind = isAudioRequest(body) ? 'audio' : 'video';
  const height = parseQuality(body.quality ?? body.resolution ?? body.height);

  if (!tryAcquireSlot()) {
    sendError(res, 429, BUSY_MESSAGE);
    return;
  }

  let tempRoot = null;
  let child = null;
  let clientGone = false;
  let released = false;
  let fileStream = null;

  const release = async () => {
    if (released) return;
    released = true;
    releaseSlot();
    await removeDir(tempRoot);
  };

  // Runs on normal completion, client disconnect, and stream errors.
  // A disconnect kills the running yt-dlp process so it cannot keep running.
  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone = true;
      killChild(child);
    }
    if (fileStream) fileStream.destroy();
    release();
  });

  try {
    const tools = await detectTools();
    if (!tools.ytDlp.available || !tools.ytDlp.path) {
      await release();
      sendError(res, 503, YTDLP_UNAVAILABLE_MESSAGE);
      return;
    }

    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));

    let output = null;
    let lastFailure = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !clientGone; attempt += 1) {
      const attemptDir = path.join(tempRoot, `attempt-${attempt}`);
      await fs.promises.mkdir(attemptDir, { recursive: true });

      const args = buildDownloadArgs({ videoId, kind, height, tools, outputDir: attemptDir });
      const result = await runProcess(tools.ytDlp.path, args, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        onSpawn: (spawned) => {
          child = spawned;
        },
      });
      child = null;

      if (clientGone) break;

      if (!result.error && !result.timedOut && result.code === 0) {
        output = await findOutputFile(attemptDir, kind);
        if (output) break;
        lastFailure = {
          status: 500,
          message: 'The download finished but no file was produced. Please try again.',
          retryable: true,
          log: `download: attempt ${attempt} exited 0 but no usable file was found`,
        };
      } else {
        lastFailure = describeFailure(result, `download attempt ${attempt}`);
      }

      if (!lastFailure.retryable || attempt === MAX_ATTEMPTS) break;
      console.warn(`[download] attempt ${attempt} failed (retryable), retrying once`);
      await delay(RETRY_DELAY_MS);
    }

    if (clientGone) return;

    if (!output) {
      await release();
      sendFailure(res, lastFailure);
      return;
    }

    // Verify the result matches what was requested.
    if (kind === 'audio' && tools.ffmpeg.available && output.ext !== '.mp3') {
      await release();
      sendError(res, 500, 'Audio conversion to MP3 failed. Please try again.');
      return;
    }

    if (kind === 'audio' && output.ext === '.mp3' && !(await looksLikeMp3(output.path))) {
      await release();
      sendError(res, 500, 'The audio conversion produced an invalid MP3 file. Please try again.');
      return;
    }

    const filename = sanitizeFilename(output.name);

    res.status(200);
    res.setHeader('Content-Type', contentTypeFor(output.name));
    res.setHeader('Content-Length', String(output.size));
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Cache-Control', 'no-store');

    fileStream = fs.createReadStream(output.path);
    fileStream.on('error', (error) => {
      console.error(`[download] read error: ${error.message}`);
      res.destroy(error);
    });
    fileStream.pipe(res);
  } catch (error) {
    console.error('[download] unexpected error:', error);
    await release();
    if (res.headersSent) {
      res.destroy();
    } else {
      sendError(res, 500, 'Unexpected server error. Please try again.');
    }
  }
});

app.use((_req, res) => {
  sendError(res, 404, 'Endpoint not found.');
});

app.use((error, _req, res, _next) => {
  if (error && error.type === 'entity.parse.failed') {
    sendError(res, 400, 'Request body must be valid JSON.');
    return;
  }
  if (error && error.type === 'entity.too.large') {
    sendError(res, 413, 'Request body is too large.');
    return;
  }
  console.error('[server] unhandled error:', error);
  sendError(res, 500, 'Unexpected server error.');
});

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

detectTools(true).then((tools) => {
  console.log(`[startup] node: ${process.version} (${process.platform}/${process.arch})`);
  console.log(`[startup] yt-dlp: ${tools.ytDlp.version || 'NOT AVAILABLE'} (${tools.ytDlp.path || 'not found'})`);
  if (tools.ffmpeg.available) {
    console.log(`[startup] ffmpeg: ${tools.ffmpeg.version} (${tools.ffmpeg.path})`);
  } else {
    console.error('[startup] ffmpeg: NOT AVAILABLE - merging and MP3 conversion are disabled');
  }
  if (tools.deno.available) {
    console.log(`[startup] deno: ${tools.deno.version} (${tools.deno.path})`);
  } else {
    console.warn('[startup] deno: NOT AVAILABLE - YouTube challenge solving may fail');
  }
  console.log(`[startup] PO token provider: ${POT_PROVIDER_CONFIGURED ? 'configured' : 'not configured'}`);
  console.log(`[startup] max concurrent downloads: ${MAX_CONCURRENT_DOWNLOADS}`);
});

sweepStaleTempDirs();
setInterval(sweepStaleTempDirs, TEMP_SWEEP_INTERVAL_MS).unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] ClipFlow listening on ${HOST}:${PORT}`);
});
server.timeout = 0;

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  for (const activeChild of activeChildren) {
    killChild(activeChild);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason);
});
