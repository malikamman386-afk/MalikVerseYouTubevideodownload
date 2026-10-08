'use strict';

/**
 * ClipFlow backend
 * Node.js 20 + Express. Requires yt-dlp (and optionally FFmpeg) on the PATH
 * or configured through YT_DLP_BIN / FFMPEG_BIN.
 *
 * Endpoints:
 *   GET  /api/status    -> tool availability and server health
 *   POST /api/info      -> { url } -> video metadata as clean JSON
 *   POST /api/download  -> { url, quality, type } -> streamed file
 */

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';
const YT_DLP_BIN = process.env.YT_DLP_BIN || 'yt-dlp';
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const MAX_CONCURRENT_DOWNLOADS = Number.parseInt(process.env.MAX_CONCURRENT_DOWNLOADS, 10) || 2;

const TOOL_CHECK_TTL_MS = 5 * 60 * 1000;
const TOOL_CHECK_TIMEOUT_MS = 15 * 1000;
const INFO_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DOWNLOAD_FILESIZE = '2G';

const TEMP_PREFIX = 'clipflow-';
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;
const TEMP_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_REQUEST_BODY = '32kb';

const INVALID_URL_MESSAGE = 'Please enter a valid YouTube video link.';
const YTDLP_UNAVAILABLE_MESSAGE =
  'The downloader (yt-dlp) is unavailable on this server. Please try again later.';

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const CONTENT_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

// Order matters: first match wins. Specific patterns come before generic ones.
const ERROR_RULES = [
  {
    pattern: /requested format is not available/i,
    status: 422,
    message: 'The requested quality is not available for this video. Try a different quality.',
  },
  {
    pattern: /sign in to confirm you(?:'|\u2019)?re not a bot|confirm you(?:'|\u2019)?re not a bot/i,
    status: 403,
    message:
      'YouTube is asking for verification (anti-bot check) for this server. Try again later or try another video.',
  },
  {
    pattern: /confirm your age|age[- ]restricted|sign in to confirm your age/i,
    status: 403,
    message: 'This video is age-restricted and cannot be downloaded.',
  },
  {
    pattern: /private video/i,
    status: 403,
    message: 'This video is private.',
  },
  {
    pattern: /members[- ]only|join this channel/i,
    status: 403,
    message: 'This video is members-only and cannot be downloaded.',
  },
  {
    pattern: /video (?:is )?unavailable|this video is not available|video has been removed|removed by the uploader|account (?:has been )?terminated/i,
    status: 404,
    message: 'This video is unavailable.',
  },
  {
    pattern: /in your country|geo[- ]?restrict|geoblock|not made this video available/i,
    status: 451,
    message: 'This video is restricted in the server region.',
  },
  {
    pattern: /ffmpeg.*(?:not (?:installed|found|available)|no such file)/i,
    status: 500,
    message: 'FFmpeg is unavailable on this server, so this request cannot be completed.',
  },
  {
    pattern: /HTTP Error 429|too many requests/i,
    status: 429,
    message: 'YouTube is rate-limiting requests from this server. Please try again later.',
  },
  {
    pattern: /timed out|timeout/i,
    status: 504,
    message: 'The request timed out. Please try again.',
  },
  {
    pattern: /HTTP Error 403|forbidden/i,
    status: 403,
    message: 'YouTube refused the request (HTTP 403). Please try again later.',
  },
  {
    pattern: /unable to download video data|HTTP Error|connection reset|network is unreachable|temporary failure/i,
    status: 502,
    message: 'A network error occurred while downloading. Please try again.',
  },
  {
    pattern: /unable to extract|could not parse/i,
    status: 502,
    message: 'Could not read video information. Please try again.',
  },
];

// ---------------------------------------------------------------------------
// App setup
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

const toolState = {
  ytDlpVersion: null,
  ffmpegAvailable: false,
  checkedAt: 0,
};

const activeChildren = new Set();
let activeDownloads = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function killChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch (_error) {
      // Process already gone.
    }
  }
}

/**
 * Runs a command with an argument array. No shell is involved.
 * Resolves (never rejects) with { code, signal, stdout, stderr, timedOut, error }.
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

async function detectTools(force = false) {
  if (!force && Date.now() - toolState.checkedAt < TOOL_CHECK_TTL_MS) {
    return toolState;
  }

  const [ytdlp, ffmpeg] = await Promise.all([
    runProcess(YT_DLP_BIN, ['--version'], { timeoutMs: TOOL_CHECK_TIMEOUT_MS }),
    runProcess(FFMPEG_BIN, ['-version'], { timeoutMs: TOOL_CHECK_TIMEOUT_MS }),
  ]);

  toolState.ytDlpVersion =
    !ytdlp.error && ytdlp.code === 0
      ? ytdlp.stdout.trim().split('\n')[0] || 'unknown'
      : null;
  toolState.ffmpegAvailable = !ffmpeg.error && ffmpeg.code === 0;
  toolState.checkedAt = Date.now();

  return toolState;
}

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

/**
 * Returns a height cap in pixels, or 0 for "best available".
 * Unrecognized values fall back to best rather than failing the request.
 */
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

/**
 * Format selector built from yt-dlp's documented "/" fallback operator.
 * Without FFmpeg, only single pre-merged (combined) formats are selected,
 * so yt-dlp never has to merge separate streams.
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

function buildCommonArgs() {
  const args = [
    '--no-config',
    '--no-cache-dir',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--no-color',
    '--socket-timeout', '20',
    '--retries', '3',
    '--fragment-retries', '5',
    '--extractor-retries', '2',
    '--file-access-retries', '3',
  ];

  // Optional PO Token provider (bgutil HTTP provider), per the yt-dlp PO Token Guide.
  // Only applied when explicitly configured. No cookies or credentials are used.
  const potUrl = process.env.YTDLP_POT_PROVIDER_URL;
  if (potUrl && /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/.test(potUrl)) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${potUrl}`);
  }

  const clients = process.env.YTDLP_PLAYER_CLIENTS;
  if (clients && /^[a-z_]+(?:,[a-z_]+)*$/.test(clients)) {
    args.push('--extractor-args', `youtube:player_client=${clients}`);
  }

  return args;
}

function buildInfoArgs(videoId) {
  return [
    ...buildCommonArgs(),
    '--dump-single-json',
    '--skip-download',
    '--',
    buildWatchUrl(videoId),
  ];
}

function buildDownloadArgs({ videoId, kind, height, ffmpegAvailable, outputDir }) {
  const args = [
    ...buildCommonArgs(),
    '--max-filesize', MAX_DOWNLOAD_FILESIZE,
    '-P', outputDir,
    '-o', '%(title).100B [%(id)s].%(ext)s',
  ];

  if (kind === 'audio') {
    args.push('-f', 'ba/b');
    if (ffmpegAvailable) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    }
  } else {
    args.push('-f', buildVideoSelector(height, ffmpegAvailable));
    if (ffmpegAvailable) {
      args.push('--merge-output-format', 'mp4');
    }
  }

  args.push('--', buildWatchUrl(videoId));
  return args;
}

/**
 * yt-dlp prints JSON to stdout. Warnings can still leak into stdout in some
 * builds, so try the whole output first, then the outermost {...} block,
 * then the last line that looks like a JSON object.
 */
function parseJsonOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    // Fall through.
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
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

function classifyYtDlpError(output) {
  const text = String(output || '');
  for (const rule of ERROR_RULES) {
    if (rule.pattern.test(text)) {
      return { status: rule.status, message: rule.message };
    }
  }
  return { status: 500, message: 'The download failed. Please try again.' };
}

function sendError(res, status, message) {
  if (res.headersSent) return;
  res.status(status).json({ ok: false, error: message });
}

function sendYtDlpError(res, result, context) {
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      sendError(res, 503, YTDLP_UNAVAILABLE_MESSAGE);
      return;
    }
    console.error(`[yt-dlp:${context}] failed to start:`, result.error.message);
    sendError(res, 500, 'The download service failed to start. Please try again later.');
    return;
  }

  if (result.timedOut) {
    console.error(`[yt-dlp:${context}] timed out`);
    sendError(res, 504, 'The request timed out. Please try again.');
    return;
  }

  console.error(
    `[yt-dlp:${context}] exit=${result.code} signal=${result.signal} stderr=${truncate(result.stderr, 1500)}`
  );
  const mapped = classifyYtDlpError(result.stderr || result.stdout);
  sendError(res, mapped.status, mapped.message);
}

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

async function findOutputFile(dir) {
  const entries = await fs.promises.readdir(dir);
  let best = null;

  for (const name of entries) {
    if (name.startsWith('.')) continue;
    if (/\.(?:part|ytdl|temp|tmp)$/i.test(name)) continue;
    if (/\.part-frag\d+$/i.test(name)) continue;

    const fullPath = path.join(dir, name);
    let stat;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch (_error) {
      continue;
    }

    if (!stat.isFile() || stat.size === 0) continue;

    if (!best || stat.mtimeMs > best.mtimeMs) {
      best = { path: fullPath, name, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  }

  return best;
}

async function removeDir(dir) {
  if (!dir) return;
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[cleanup] failed to remove ${dir}:`, error.message);
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
            // Ignore entries that disappear mid-sweep.
          }
        })
    );
  } catch (error) {
    console.warn('[cleanup] temp sweep failed:', error.message);
  }
}

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
      available: Boolean(tools.ytDlpVersion),
      version: tools.ytDlpVersion,
    },
    ffmpeg: {
      available: tools.ffmpegAvailable,
    },
    activeDownloads,
    maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS,
    node: process.version,
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
    if (!tools.ytDlpVersion) {
      sendError(res, 503, YTDLP_UNAVAILABLE_MESSAGE);
      return;
    }

    const result = await runProcess(YT_DLP_BIN, buildInfoArgs(videoId), {
      timeoutMs: INFO_TIMEOUT_MS,
    });

    if (result.error || result.timedOut || result.code !== 0) {
      sendYtDlpError(res, result, 'info');
      return;
    }

    const data = parseJsonOutput(result.stdout);
    if (!data || typeof data !== 'object') {
      console.error('[yt-dlp:info] could not parse JSON output');
      sendError(res, 502, 'Could not read video information. Please try again.');
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
    sendError(res, 429, 'The server is busy with other downloads. Please try again in a moment.');
    return;
  }

  let tempDir = null;
  let child = null;
  let released = false;
  let clientGone = false;
  let fileStream = null;

  const release = async () => {
    if (released) return;
    released = true;
    releaseSlot();
    await removeDir(tempDir);
  };

  // Covers normal completion, client disconnects, and stream errors.
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
    if (!tools.ytDlpVersion) {
      await release();
      sendError(res, 503, YTDLP_UNAVAILABLE_MESSAGE);
      return;
    }

    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));

    const args = buildDownloadArgs({
      videoId,
      kind,
      height,
      ffmpegAvailable: tools.ffmpegAvailable,
      outputDir: tempDir,
    });

    const result = await runProcess(YT_DLP_BIN, args, {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      onSpawn: (spawned) => {
        child = spawned;
      },
    });

    if (clientGone) return;

    if (result.error || result.timedOut || result.code !== 0) {
      await release();
      sendYtDlpError(res, result, 'download');
      return;
    }

    const output = await findOutputFile(tempDir);
    if (!output) {
      console.error('[download] yt-dlp succeeded but no output file was found');
      await release();
      sendError(res, 500, 'The download finished but no file was produced. Please try again.');
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
      console.error('[download] read error:', error.message);
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

// 404 for unknown routes
app.use((_req, res) => {
  sendError(res, 404, 'Endpoint not found.');
});

// Central error handler
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
  console.log(`[startup] yt-dlp: ${tools.ytDlpVersion || 'NOT AVAILABLE'}`);
  if (tools.ffmpegAvailable) {
    console.log('[ffmpeg] available');
  } else {
    console.warn('[ffmpeg] NOT AVAILABLE - using single combined formats only');
  }
});

sweepStaleTempDirs();
setInterval(sweepStaleTempDirs, TEMP_SWEEP_INTERVAL_MS).unref();

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] ClipFlow listening on http://${HOST}:${PORT}`);
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
