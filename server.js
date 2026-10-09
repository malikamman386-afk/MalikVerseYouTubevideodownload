'use strict';

/**
 * ClipFlow / MalikVerse YouTube Downloader backend.
 *
 * Endpoints:
 *   GET  /api/status
 *   GET  /api/diagnostics
 *   POST /api/info
 *   POST /api/download
 *
 * Errors: { ok: false, code: "...", error: "..." }
 *
 * All processes use spawn() with an argument array; no shell execution.
 * No cookies or credentials are read, passed, or logged.
 */

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
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

const YTDLP_VERBOSE = process.env.YTDLP_VERBOSE !== 'false';

const BGUTIL_ENABLED = process.env.BGUTIL_ENABLED !== 'false';
const BGUTIL_MAIN =
  process.env.BGUTIL_MAIN || '/opt/bgutil/server/build/main.js';

const BGUTIL_PORT = clampInt(process.env.BGUTIL_PORT, 4416, 1024, 65535);
const BGUTIL_MAX_RESTARTS = 5;
const BGUTIL_READY_TIMEOUT_MS = 60 * 1000;

const POT_OVERRIDE_URL = process.env.YTDLP_POT_PROVIDER_URL || '';
const POT_URL_RE =
  /^https?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]*)?$/;

const MAX_CONCURRENT_DOWNLOADS = clampInt(
  process.env.MAX_CONCURRENT_DOWNLOADS,
  2,
  1,
  4
);

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 3000;

const TOOL_CACHE_MS = 5 * 60 * 1000;
const TOOL_PROBE_TIMEOUT_MS = 20 * 1000;
const INFO_TIMEOUT_MS = 90 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DIAGNOSTICS_COOLDOWN_MS = 60 * 1000;

const DIAGNOSTIC_VIDEO_ID = 'jNQXAC9IVRw';
const MAX_DOWNLOAD_FILESIZE = '2G';

const TEMP_PREFIX = 'clipflow-';
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;
const TEMP_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_REQUEST_BODY = '32kb';

const INVALID_URL_MESSAGE =
  'Please enter a valid YouTube video link.';

const YTDLP_UNAVAILABLE_MESSAGE =
  'The downloader (yt-dlp) is unavailable on this server. Please try again later.';

const BUSY_MESSAGE =
  'The server is busy with other downloads. Please try again in a moment.';

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

const AUDIO_EXTS = new Set([
  '.mp3',
  '.m4a',
  '.opus',
  '.ogg',
  '.aac',
  '.mka',
  '.webm',
]);

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

const DEBUG_KEEP_RE =
  /pot|jsc|challenge|bgutil|plugin|provider|player|client|warning|error|sign in|bot|format|429|403|forbidden|http/i;

const ERROR_RULES = [
  {
    pattern:
      /sign in to confirm you(?:'|\u2019)?re not a bot|confirm you(?:'|\u2019)?re not a bot/i,
    status: 403,
    code: 'BOT_VERIFICATION',
    retryable: false,
    message:
      'YouTube is asking this server to verify that it is not a bot, so this video cannot be downloaded from here right now. Try again later or try a different video.',
  },
  {
    pattern: /requested format is not available|no video formats found/i,
    status: 422,
    code: 'FORMAT_UNAVAILABLE',
    retryable: false,
    message:
      'The requested quality is not available for this video. Try a different quality.',
  },
  {
    pattern: /confirm your age|age[- ]restricted|sign in to confirm your age/i,
    status: 403,
    code: 'AGE_RESTRICTED',
    retryable: false,
    message: 'This video is age-restricted and cannot be downloaded.',
  },
  {
    pattern: /private video/i,
    status: 403,
    code: 'PRIVATE_VIDEO',
    retryable: false,
    message: 'This video is private.',
  },
  {
    pattern: /members[- ]only|join this channel/i,
    status: 403,
    code: 'MEMBERS_ONLY',
    retryable: false,
    message:
      'This video is for channel members only and cannot be downloaded.',
  },
  {
    pattern:
      /in your country|geo[- ]?restrict|geoblock|not made this video available/i,
    status: 451,
    code: 'GEO_RESTRICTED',
    retryable: false,
    message: 'This video is restricted in the server region.',
  },
  {
    pattern:
      /n challenge solving failed|signature solving failed|challenge solver/i,
    status: 502,
    code: 'CHALLENGE_FAILED',
    retryable: false,
    message:
      'YouTube challenge solving failed on the server. The JavaScript runtime or yt-dlp needs an update.',
  },
  {
    pattern:
      /video (?:is )?unavailable|this video is not available|video has been removed|removed by the uploader|account (?:has been )?terminated/i,
    status: 404,
    code: 'VIDEO_UNAVAILABLE',
    retryable: false,
    message:
      'This video is unavailable, or YouTube did not return it to this server. Check that the link opens in a browser.',
  },
  {
    pattern:
      /ffmpeg.*(?:not (?:installed|found|available)|no such file)/i,
    status: 500,
    code: 'FFMPEG_MISSING',
    retryable: false,
    message:
      'FFmpeg is unavailable on this server, so this request cannot be completed.',
  },
  {
    pattern: /HTTP Error 429|too many requests/i,
    status: 429,
    code: 'RATE_LIMITED',
    retryable: false,
    message:
      'YouTube is rate-limiting this server. Please wait before trying again.',
  },
  {
    pattern: /HTTP Error 403|forbidden/i,
    status: 403,
    code: 'HTTP_FORBIDDEN',
    retryable: false,
    message: 'YouTube refused the request (HTTP 403). Try again later.',
  },
  {
    pattern: /timed out|timeout/i,
    status: 504,
    code: 'TIMEOUT',
    retryable: true,
    message: 'The request timed out. Please try again.',
  },
  {
    pattern:
      /HTTP Error 5\d\d|unable to download video data|unable to download webpage|connection reset|network is unreachable|temporary failure|incomplete read/i,
    status: 502,
    code: 'NETWORK_ERROR',
    retryable: true,
    message:
      'A network error occurred while downloading. Please try again.',
  },
  {
    pattern: /unable to extract|could not parse/i,
    status: 502,
    code: 'PARSE_ERROR',
    retryable: true,
    message:
      'Could not read video information from YouTube. Please try again.',
  },
];

// ---------------------------------------------------------------------------
// Application setup
// ---------------------------------------------------------------------------

const app = express();

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Disposition, Content-Length, X-ClipFlow-Notice'
  );
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
let lastDiagnosticsAt = 0;

const potProvider = {
  child: null,
  restarts: 0,
  lastExit: null,
  restartPending: false,
  stopping: false,
};

function emptyToolState() {
  return {
    checkedAt: 0,
    ytDlp: {
      available: false,
      path: null,
      version: null,
    },
    ffmpeg: {
      available: false,
      path: null,
      version: null,
      mp3Encoder: false,
    },
    deno: {
      available: false,
      path: null,
      version: null,
    },
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

  return value.length > max
    ? `${value.slice(0, max)}...`
    : value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sanitizes output before it reaches logs.
 * URLs, tokens, cookies, credentials and long opaque values are removed.
 */
function sanitizeForLog(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(
      /\b(po[_ -]?token|visitor[_ -]?data|pot|sig|signature|cookies?|set-cookie|authorization|token|password|secret|api[_ -]?key|session)\b\s*[=:]\s*[^\s&,;'"]+/gi,
      '$1=[redacted]'
    )
    .replace(/\/tmp\/clipflow-[^\s'"]*/g, '[tmp]')
    .replace(/[A-Za-z0-9_\-+/=]{40,}/g, '[long-token]')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractErrorLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const errorLine = lines.find((line) => /^ERROR:/i.test(line));

  if (!errorLine) return null;

  return sanitizeForLog(errorLine).slice(0, 240);
}

function debugExcerpt(text, maxLines = 40) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && DEBUG_KEEP_RE.test(line))
    .slice(-maxLines)
    .map((line) => sanitizeForLog(truncate(line, 300)));
}

function killChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch (_error) {
      // The process may already have exited.
    }
  }
}

/**
 * Runs a process without a shell.
 * Always resolves with exit details rather than throwing.
 */
function runProcess(bin, args, options = {}) {
  const {
    timeoutMs = 0,
    onSpawn,
  } = options;

  return new Promise((resolve) => {
    let child;

    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error,
      });
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
      if (stdout.length < MAX_STDOUT_BYTES) {
        stdout += chunk;
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk;
      }
    });

    const finish = (result) => {
      if (settled) return;

      settled = true;

      if (timer) clearTimeout(timer);

      activeChildren.delete(child);

      resolve({
        ...result,
        stdout,
        stderr,
        timedOut,
      });
    };

    child.on('error', (error) => {
      finish({
        code: null,
        signal: null,
        error,
      });
    });

    child.on('close', (code, signal) => {
      finish({
        code,
        signal,
        error: null,
      });
    });
  });
}

/**
 * Finds an executable on PATH or checks a supplied absolute path.
 */
async function resolveBinary(bin) {
  if (bin.includes('/')) {
    try {
      await fs.promises.access(bin, fs.constants.X_OK);
      return bin;
    } catch (_error) {
      return null;
    }
  }

  const dirs = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);

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
  const result = await runProcess(binPath, args, {
    timeoutMs: TOOL_PROBE_TIMEOUT_MS,
  });

  if (result.error || result.timedOut || result.code !== 0) {
    return null;
  }

  const firstLine =
    result.stdout.trim().split('\n')[0] ||
    result.stderr.trim().split('\n')[0] ||
    '';

  return firstLine.trim() || 'unknown';
}

async function probeMp3Encoder(ffmpegPath) {
  if (!ffmpegPath) return false;

  const result = await runProcess(
    ffmpegPath,
    ['-hide_banner', '-encoders'],
    { timeoutMs: TOOL_PROBE_TIMEOUT_MS }
  );

  return (
    !result.error &&
    result.code === 0 &&
    result.stdout.includes('libmp3lame')
  );
}

async function detectTools(force = false) {
  if (
    !force &&
    Date.now() - toolState.checkedAt < TOOL_CACHE_MS
  ) {
    return toolState;
  }

  const [
    ytdlpPath,
    ffmpegPath,
    denoPath,
  ] = await Promise.all([
    resolveBinary(YT_DLP_BIN),
    resolveBinary(FFMPEG_BIN),
    resolveBinary(DENO_BIN),
  ]);

  const [
    ytdlpVersion,
    ffmpegVersion,
    denoVersion,
    mp3Encoder,
  ] = await Promise.all([
    ytdlpPath
      ? probeVersion(ytdlpPath, ['--version'])
      : null,

    ffmpegPath
      ? probeVersion(ffmpegPath, ['-version'])
      : null,

    denoPath
      ? probeVersion(denoPath, ['--version'])
      : null,

    probeMp3Encoder(ffmpegPath),
  ]);

  toolState = {
    checkedAt: Date.now(),

    ytDlp: {
      available: Boolean(ytdlpVersion),
      path: ytdlpPath,
      version: ytdlpVersion,
    },

    ffmpeg: {
      available: Boolean(ffmpegVersion),
      path: ffmpegPath,
      version: ffmpegVersion,
      mp3Encoder,
    },

    deno: {
      available: Boolean(denoVersion),
      path: denoPath,
      version: denoVersion,
    },
  };

  return toolState;
}

function audioConversionAvailable(tools) {
  return tools.ffmpeg.available && tools.ffmpeg.mp3Encoder;
}

// ---------------------------------------------------------------------------
// PO token provider: bundled bgutil HTTP server
// ---------------------------------------------------------------------------

function isPortOpen(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({
      port,
      host: '127.0.0.1',
    });

    let done = false;

    const finish = (ok) => {
      if (done) return;

      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

function logProviderOutput(chunk) {
  const lines = String(chunk || '')
    .split('\n')
    .filter((line) => line.trim());

  for (const line of lines.slice(0, 50)) {
    console.log(
      `[pot-provider] ${sanitizeForLog(truncate(line, 300))}`
    );
  }
}

function scheduleProviderRestart() {
  if (potProvider.stopping || potProvider.restartPending) {
    return;
  }

  if (potProvider.restarts >= BGUTIL_MAX_RESTARTS) {
    console.error(
      `[pot-provider] stopped after ${BGUTIL_MAX_RESTARTS} restarts; not retrying`
    );
    return;
  }

  potProvider.restartPending = true;
  potProvider.restarts += 1;

  const waitMs = Math.min(30000, 2000 * potProvider.restarts);

  console.warn(
    `[pot-provider] restarting in ${waitMs} ms (attempt ${potProvider.restarts})`
  );

  setTimeout(() => {
    potProvider.restartPending = false;
    startPotProvider();
  }, waitMs).unref();
}

function startPotProvider() {
  if (!BGUTIL_ENABLED) {
    console.log(
      '[pot-provider] disabled by BGUTIL_ENABLED=false'
    );
    return;
  }

  if (!fs.existsSync(BGUTIL_MAIN)) {
    console.error(
      `[pot-provider] NOT FOUND at ${BGUTIL_MAIN}; PO token support is unavailable`
    );
    return;
  }

  if (potProvider.child) return;

  const env = { ...process.env };

  // The provider must not try to bind the app's HTTP port.
  delete env.PORT;

  let child;

  try {
    child = spawn(process.execPath, [BGUTIL_MAIN], {
      cwd: path.dirname(path.dirname(BGUTIL_MAIN)),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    console.error(
      `[pot-provider] failed to spawn: ${error.code || 'unknown error'}`
    );

    scheduleProviderRestart();
    return;
  }

  potProvider.child = child;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', logProviderOutput);
  child.stderr.on('data', logProviderOutput);

  child.on('error', (error) => {
    console.error(
      `[pot-provider] process error: ${error.code || 'unknown error'}`
    );

    potProvider.child = null;
    scheduleProviderRestart();
  });

  child.on('exit', (code, signal) => {
    potProvider.child = null;

    potProvider.lastExit = {
      code,
      signal,
      at: new Date().toISOString(),
    };

    console.warn(
      `[pot-provider] exited code=${code} signal=${signal}`
    );

    if (!potProvider.stopping) {
      scheduleProviderRestart();
    }
  });

  waitForProviderReady();
}

async function waitForProviderReady() {
  const deadline = Date.now() + BGUTIL_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (!potProvider.child) return;

    if (await isPortOpen(BGUTIL_PORT)) {
      console.log(
        `[pot-provider] listening on 127.0.0.1:${BGUTIL_PORT}`
      );
      return;
    }

    await delay(1000);
  }

  console.warn(
    `[pot-provider] not reachable on 127.0.0.1:${BGUTIL_PORT} after startup`
  );
}

async function resolvePotBaseUrl() {
  if (POT_OVERRIDE_URL && POT_URL_RE.test(POT_OVERRIDE_URL)) {
    return POT_OVERRIDE_URL;
  }

  if (BGUTIL_ENABLED && await isPortOpen(BGUTIL_PORT)) {
    return `http://127.0.0.1:${BGUTIL_PORT}`;
  }

  return null;
}

async function providerStatus() {
  const reachable = BGUTIL_ENABLED
    ? await isPortOpen(BGUTIL_PORT)
    : false;

  return {
    enabled: BGUTIL_ENABLED,
    bundledPresent: fs.existsSync(BGUTIL_MAIN),
    reachable,
    running: Boolean(potProvider.child),
    restarts: potProvider.restarts,
    lastExit: potProvider.lastExit,
    overrideConfigured: Boolean(
      POT_OVERRIDE_URL && POT_URL_RE.test(POT_OVERRIDE_URL)
    ),
  };
}

// ---------------------------------------------------------------------------
// URL and option handling
// ---------------------------------------------------------------------------

function extractVideoId(input) {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();

  if (trimmed.length === 0 || trimmed.length > 500) {
    return null;
  }

  let url;

  try {
    url = new URL(trimmed);
  } catch (_error) {
    return null;
  }

  if (
    url.protocol !== 'https:' &&
    url.protocol !== 'http:'
  ) {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (!ALLOWED_HOSTS.has(host)) {
    return null;
  }

  let id = null;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] || null;
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else {
    const match = url.pathname.match(
      /^\/(?:shorts|embed|live|v)\/([^/?#]+)/
    );

    if (match) id = match[1];
  }

  return id && VIDEO_ID_RE.test(id) ? id : null;
}

function buildWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function parseQuality(value) {
  if (value === undefined || value === null) return 0;

  const str = String(value).trim().toLowerCase();

  if (
    str === '' ||
    str === 'best' ||
    str === 'auto' ||
    str === 'max'
  ) {
    return 0;
  }

  const match = str.match(/^(\d{3,4})p?$/);

  if (!match) return 0;

  const height = Number.parseInt(match[1], 10);

  if (height < 144 || height > 4320) return 0;

  return height;
}

function isAudioRequest(body) {
  if (body.audioOnly === true) return true;

  const type = String(
    body.type ?? body.format ?? ''
  ).trim().toLowerCase();

  return type === 'mp3' || type === 'audio' || type === 'm4a';
}

// ---------------------------------------------------------------------------
// yt-dlp argument construction
// ---------------------------------------------------------------------------

function buildVideoSelector(height, ffmpegAvailable) {
  if (!ffmpegAvailable) {
    return height > 0
      ? `b[height<=${height}]/b`
      : 'b';
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

function buildCommonArgs(tools, potBaseUrl, options = {}) {
  const args = [
    '--no-config',
    '--no-cache-dir',
    '--no-playlist',
    '--no-progress',
    '--no-color',
    '--socket-timeout',
    '20',
    '--retries',
    '3',
    '--fragment-retries',
    '5',
    '--extractor-retries',
    '2',
    '--file-access-retries',
    '3',
  ];

  if (tools.deno.available && tools.deno.path) {
    args.push('--js-runtimes', `deno:${tools.deno.path}`);
  }

  if (potBaseUrl) {
    args.push(
      '--extractor-args',
      `youtubepot-bgutilhttp:base_url=${potBaseUrl}`
    );
  }

  if (YTDLP_VERBOSE || options.verbose) {
    args.push('-v');
  }

  return args;
}

function buildInfoArgs(videoId, tools, potBaseUrl) {
  return [
    ...buildCommonArgs(tools, potBaseUrl),
    '--dump-single-json',
    '--skip-download',
    '--',
    buildWatchUrl(videoId),
  ];
}

function buildDownloadArgs({
  videoId,
  kind,
  height,
  tools,
  potBaseUrl,
  outputDir,
  convertToMp3,
}) {
  const args = [
    ...buildCommonArgs(tools, potBaseUrl),
    '--max-filesize',
    MAX_DOWNLOAD_FILESIZE,
    '-P',
    outputDir,
    '-o',
    '%(title).100B [%(id)s].%(ext)s',
  ];

  if (kind === 'audio') {
    args.push('-f', 'ba/b');

    if (convertToMp3) {
      args.push(
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0'
      );
    }
  } else {
    args.push('-f', buildVideoSelector(height, tools.ffmpeg.available));

    if (tools.ffmpeg.available) {
      // FIX: this option accepts one output container extension.
      args.push('--merge-output-format', 'mp4');
    }
  }

  args.push('--', buildWatchUrl(videoId));

  return args;
}

// ---------------------------------------------------------------------------
// Output parsing and error mapping
// ---------------------------------------------------------------------------

function parseJsonOutput(stdout) {
  const trimmed = String(stdout || '').trim();

  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);

    return parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (_error) {
    // Fall through to alternative parsing.
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');

  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(
        trimmed.slice(start, end + 1)
      );

      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        return parsed;
      }
    } catch (_error) {
      // Try each line next.
    }
  }

  const lines = trimmed.split('\n').reverse();

  for (const line of lines) {
    const candidate = line.trim();

    if (
      candidate.startsWith('{') &&
      candidate.endsWith('}')
    ) {
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
    duration:
      typeof data.duration === 'number'
        ? data.duration
        : null,
    uploader: data.uploader || data.channel || null,
    channel: data.channel || data.uploader || null,
    webpage_url:
      data.webpage_url || buildWatchUrl(videoId),
  };
}

function classifyYtDlpError(text) {
  const errorLine = extractErrorLine(text);
  const candidates = [
    errorLine,
    String(text || ''),
  ].filter(Boolean);

  for (const candidate of candidates) {
    for (const rule of ERROR_RULES) {
      if (rule.pattern.test(candidate)) {
        return {
          status: rule.status,
          code: rule.code,
          message: rule.message,
          retryable: rule.retryable,
        };
      }
    }
  }

  return null;
}

function describeFailure(result, context) {
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return {
        status: 503,
        code: 'YTDLP_UNAVAILABLE',
        message: YTDLP_UNAVAILABLE_MESSAGE,
        retryable: false,
        log: `${context}: executable not found`,
        debug: [],
      };
    }

    return {
      status: 500,
      code: 'SPAWN_ERROR',
      message:
        'The download service failed to start. Please try again later.',
      retryable: false,
      log:
        `${context}: spawn error code=${result.error.code || 'unknown'}`,
      debug: [],
    };
  }

  const rawText = result.stderr || result.stdout || '';

  const log =
    `${context}: exit=${result.code} ` +
    `signal=${result.signal || 'none'} ` +
    `timedOut=${Boolean(result.timedOut)} ` +
    `stderr="${sanitizeForLog(truncate(rawText, 1500))}"`;

  const debug = debugExcerpt(rawText);

  if (result.timedOut) {
    return {
      status: 504,
      code: 'TIMEOUT',
      message: 'The request timed out. Please try again.',
      retryable: true,
      log,
      debug,
    };
  }

  const classified = classifyYtDlpError(rawText);

  if (classified) {
    return {
      ...classified,
      log,
      debug,
    };
  }

  const errorLine = extractErrorLine(rawText);

  return {
    status: 500,
    code: 'YTDLP_ERROR',
    message: errorLine
      ? `Download failed: ${errorLine}`
      : 'Download failed. yt-dlp returned an unexpected error. Check the server logs.',
    retryable: false,
    log,
    debug,
  };
}

function sendError(res, status, message, code = 'ERROR') {
  if (res.headersSent) return;

  res.status(status).json({
    ok: false,
    code,
    error: message,
  });
}

function sendFailure(res, failure) {
  if (!failure) {
    sendError(
      res,
      500,
      'Download failed. Please try again.',
      'UNKNOWN'
    );

    return;
  }

  if (failure.log) {
    console.error(`[failure] ${failure.log}`);
  }

  if (failure.debug && failure.debug.length > 0) {
    console.error(
      `[failure:debug]\n  ${failure.debug.join('\n  ')}`
    );
  }

  sendError(
    res,
    failure.status,
    failure.message,
    failure.code
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
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/"/g, "'");

  return (
    `attachment; filename="${ascii}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`
  );
}

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();

  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

async function findOutputFile(dir, kind) {
  const allowedExts =
    kind === 'audio'
      ? AUDIO_EXTS
      : VIDEO_EXTS;

  const entries = await fs.promises.readdir(dir);

  let best = null;

  for (const name of entries) {
    if (name.startsWith('.')) continue;

    if (/\.(?:part|ytdl|temp|tmp)$/i.test(name)) {
      continue;
    }

    if (/\.part-frag\d+$/i.test(name)) continue;
    if (/\.f\d+\./i.test(name)) continue;

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
      best = {
        path: fullPath,
        name,
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    }
  }

  return best;
}

async function looksLikeMp3(filePath) {
  const handle = await fs.promises.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(3);

    const { bytesRead } = await handle.read(
      buffer,
      0,
      3,
      0
    );

    if (bytesRead < 2) return false;

    if (buffer.toString('ascii', 0, 3) === 'ID3') {
      return true;
    }

    return (
      buffer[0] === 0xff &&
      (buffer[1] & 0xe0) === 0xe0
    );
  } finally {
    await handle.close();
  }
}

async function removeDir(dir) {
  if (!dir) return;

  try {
    await fs.promises.rm(dir, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.warn(
      `[cleanup] failed to remove temp directory: ${error.code || 'unknown error'}`
    );
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
            // The entry may have disappeared during cleanup.
          }
        })
    );
  } catch (error) {
    console.warn(
      `[cleanup] temp sweep failed: ${error.code || 'unknown error'}`
    );
  }
}

function buildNotice(kind, convertToMp3, tools) {
  if (kind === 'audio' && !convertToMp3) {
    return 'AUDIO_NATIVE_FORMAT';
  }

  if (kind === 'video' && !tools.ffmpeg.available) {
    return 'SINGLE_STREAM_NO_FFMPEG';
  }

  return null;
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

function tryAcquireSlot() {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    return false;
  }

  activeDownloads += 1;
  return true;
}

function releaseSlot() {
  activeDownloads = Math.max(0, activeDownloads - 1);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function runDiagnostics() {
  const tools = await detectTools(true);
  const potBaseUrl = await resolvePotBaseUrl();
  const provider = await providerStatus();

  const checks = {
    ytDlp: tools.ytDlp,
    ffmpeg: tools.ffmpeg,
    deno: tools.deno,

    potProvider: {
      ...provider,
      baseUrlUsed: potBaseUrl
        ? potBaseUrl.replace(/\d+$/, '<port>')
        : null,
    },
  };

  if (!tools.ytDlp.available || !tools.ytDlp.path) {
    return {
      ok: false,
      diagnosis:
        'yt-dlp is not installed or not on PATH. Rebuild the Docker image.',
      checks,
      probe: null,
      debugExcerpt: [],
    };
  }

  const args = [
    ...buildCommonArgs(tools, potBaseUrl, {
      verbose: true,
    }),
    '--dump-single-json',
    '--skip-download',
    '--',
    buildWatchUrl(DIAGNOSTIC_VIDEO_ID),
  ];

  const result = await runProcess(
    tools.ytDlp.path,
    args,
    { timeoutMs: INFO_TIMEOUT_MS }
  );

  const raw = result.stderr || '';

  const potLines = raw
    .split('\n')
    .filter((line) => /po token/i.test(line));

  const potDetectedByYtDlp = potLines.some(
    (line) => /bgutil/i.test(line)
  );

  const jsLines = raw
    .split('\n')
    .filter((line) =>
      /JS Challenge Providers|\[jsc/i.test(line)
    );

  const parsed =
    result.code === 0
      ? parseJsonOutput(result.stdout)
      : null;

  const classified = parsed
    ? null
    : classifyYtDlpError(raw);

  let diagnosis;

  if (parsed) {
    diagnosis =
      'Probe succeeded. YouTube returned metadata for the fixed test video.';
  } else if (result.timedOut) {
    diagnosis =
      'The probe timed out. Check network access from the container and retry later.';
  } else if (
    classified &&
    classified.code === 'BOT_VERIFICATION'
  ) {
    if (!potBaseUrl) {
      diagnosis =
        'YouTube requires verification and the PO token provider is not reachable. Check the [pot-provider] lines in the startup log.';
    } else if (!potDetectedByYtDlp) {
      diagnosis =
        'The PO token provider is reachable, but yt-dlp did not load the plugin. Check that bgutil-ytdlp-pot-provider is installed in the yt-dlp environment and matches the provider server version.';
    } else {
      diagnosis =
        'The PO token provider is reachable and loaded, but YouTube still requires verification for this server IP or session. PO tokens cannot remove this on their own. The remaining options are a different network or an authenticated session you control, which this server does not implement.';
    }
  } else if (
    classified &&
    classified.code === 'RATE_LIMITED'
  ) {
    diagnosis =
      'YouTube is rate-limiting this server. Wait before retrying; do not retry in a loop.';
  } else if (classified) {
    diagnosis = `${classified.code}: ${classified.message}`;
  } else {
    diagnosis =
      'The probe failed with an unrecognized error. See the sanitized debug excerpt.';
  }

  return {
    ok: Boolean(parsed),
    diagnosis,

    checks: {
      ...checks,

      potProvider: {
        ...checks.potProvider,
        detectedByYtDlp: potDetectedByYtDlp,
      },

      jsRuntime: {
        denoAvailable: tools.deno.available,

        ytDlpReportedProviders: jsLines
          .slice(-3)
          .map((line) =>
            sanitizeForLog(truncate(line, 200))
          ),
      },
    },

    probe: {
      videoId: DIAGNOSTIC_VIDEO_ID,
      exitCode: result.code,
      signal: result.signal || null,
      timedOut: Boolean(result.timedOut),
      errorCode: classified ? classified.code : null,
      sanitizedError: extractErrorLine(raw),
    },

    debugExcerpt: debugExcerpt(raw, 40),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/status', async (_req, res) => {
  try {
    const tools = await detectTools();
    const provider = await providerStatus();

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
        mp3Encoder: tools.ffmpeg.mp3Encoder,
      },

      deno: {
        available: tools.deno.available,
        version: tools.deno.version,
        path: tools.deno.path,
      },

      potProvider: provider,
      verboseLogging: YTDLP_VERBOSE,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      activeDownloads,
      maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS,
      uptimeSeconds: Math.round(process.uptime()),
    });
  } catch (error) {
    console.error(
      `[status] unexpected error: ${error.code || error.name || 'unknown'}`
    );

    sendError(
      res,
      500,
      'Could not read server status.',
      'STATUS_ERROR'
    );
  }
});

app.get('/api/diagnostics', async (_req, res) => {
  const now = Date.now();

  if (now - lastDiagnosticsAt < DIAGNOSTICS_COOLDOWN_MS) {
    sendError(
      res,
      429,
      'Diagnostics ran recently. Wait a minute and try again.',
      'DIAGNOSTICS_COOLDOWN'
    );

    return;
  }

  lastDiagnosticsAt = now;

  try {
    const report = await runDiagnostics();

    console.log(`[diagnostics] ${report.diagnosis}`);

    if (report.debugExcerpt.length > 0) {
      console.log(
        `[diagnostics:debug]\n  ${report.debugExcerpt.join('\n  ')}`
      );
    }

    res.status(report.ok ? 200 : 502).json({
      ok: report.ok,
      ...report,
    });
  } catch (error) {
    console.error(
      `[diagnostics] unexpected error: ${error.code || error.name || 'unknown'}`
    );

    sendError(
      res,
      500,
      'Diagnostics failed. Check the server logs.',
      'SERVER_ERROR'
    );
  }
});

app.post('/api/info', async (req, res) => {
  const body = req.body || {};
  const videoId = extractVideoId(body.url);

  if (!videoId) {
    sendError(
      res,
      400,
      INVALID_URL_MESSAGE,
      'INVALID_URL'
    );

    return;
  }

  try {
    const tools = await detectTools();

    if (!tools.ytDlp.available || !tools.ytDlp.path) {
      sendError(
        res,
        503,
        YTDLP_UNAVAILABLE_MESSAGE,
        'YTDLP_UNAVAILABLE'
      );

      return;
    }

    const potBaseUrl = await resolvePotBaseUrl();

    const result = await runProcess(
      tools.ytDlp.path,
      buildInfoArgs(videoId, tools, potBaseUrl),
      { timeoutMs: INFO_TIMEOUT_MS }
    );

    if (result.error || result.timedOut || result.code !== 0) {
      sendFailure(res, describeFailure(result, 'info'));
      return;
    }

    const data = parseJsonOutput(result.stdout);

    if (!data) {
      const log =
        `info: unparseable JSON. stdout="${sanitizeForLog(truncate(result.stdout, 300))}" ` +
        `stderr="${sanitizeForLog(truncate(result.stderr, 600))}"`;

      const classified = classifyYtDlpError(result.stderr);
      const debug = debugExcerpt(result.stderr);

      sendFailure(
        res,
        classified
          ? {
              ...classified,
              log,
              debug,
            }
          : {
              status: 502,
              code: 'PARSE_ERROR',
              message:
                'Could not read video information. Please try again.',
              retryable: true,
              log,
              debug,
            }
      );

      return;
    }

    res.json({
      ok: true,
      ...toInfoResponse(data, videoId),
    });
  } catch (error) {
    console.error(
      `[info] unexpected error: ${error.code || error.name || 'unknown'}`
    );

    sendError(
      res,
      500,
      'Unexpected server error. Please try again.',
      'SERVER_ERROR'
    );
  }
});

app.post('/api/download', async (req, res) => {
  const body = req.body || {};
  const videoId = extractVideoId(body.url);

  if (!videoId) {
    sendError(
      res,
      400,
      INVALID_URL_MESSAGE,
      'INVALID_URL'
    );

    return;
  }

  const kind = isAudioRequest(body)
    ? 'audio'
    : 'video';

  const height = parseQuality(
    body.quality ?? body.resolution ?? body.height
  );

  if (!tryAcquireSlot()) {
    sendError(
      res,
      429,
      BUSY_MESSAGE,
      'BUSY'
    );

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

  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone = true;
      killChild(child);
    }

    if (fileStream) {
      fileStream.destroy();
    }

    release();
  });

  try {
    const tools = await detectTools();

    if (!tools.ytDlp.available || !tools.ytDlp.path) {
      await release();

      sendError(
        res,
        503,
        YTDLP_UNAVAILABLE_MESSAGE,
        'YTDLP_UNAVAILABLE'
      );

      return;
    }

    const convertToMp3 =
      kind === 'audio' &&
      audioConversionAvailable(tools);

    const potBaseUrl = await resolvePotBaseUrl();

    tempRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), TEMP_PREFIX)
    );

    let output = null;
    let lastFailure = null;

    for (
      let attempt = 1;
      attempt <= MAX_ATTEMPTS && !clientGone;
      attempt += 1
    ) {
      const attemptDir = path.join(
        tempRoot,
        `attempt-${attempt}`
      );

      await fs.promises.mkdir(attemptDir, {
        recursive: true,
      });

      const args = buildDownloadArgs({
        videoId,
        kind,
        height,
        tools,
        potBaseUrl,
        outputDir: attemptDir,
        convertToMp3,
      });

      const result = await runProcess(
        tools.ytDlp.path,
        args,
        {
          timeoutMs: DOWNLOAD_TIMEOUT_MS,

          onSpawn: (spawned) => {
            child = spawned;
          },
        }
      );

      child = null;

      if (clientGone) break;

      if (
        !result.error &&
        !result.timedOut &&
        result.code === 0
      ) {
        output = await findOutputFile(
          attemptDir,
          kind
        );

        if (output) break;

        lastFailure = {
          status: 500,
          code: 'NO_OUTPUT_FILE',
          message:
            'The download finished but no file was produced. Please try again.',
          retryable: true,
          log:
            `download: attempt ${attempt} exited 0 without a usable file`,
          debug: [],
        };
      } else {
        lastFailure = describeFailure(
          result,
          `download attempt ${attempt}`
        );
      }

      // Don't retry permanent failures such as bot verification or rate limits.
      if (
        !lastFailure.retryable ||
        attempt === MAX_ATTEMPTS
      ) {
        break;
      }

      console.warn(
        `[download] attempt ${attempt} failed with a transient error, retrying once`
      );

      await delay(RETRY_DELAY_MS);
    }

    if (clientGone) return;

    if (!output) {
      await release();
      sendFailure(res, lastFailure);
      return;
    }

    if (
      kind === 'audio' &&
      convertToMp3 &&
      output.ext !== '.mp3'
    ) {
      await release();

      sendError(
        res,
        500,
        'Audio conversion to MP3 failed. Please try again.',
        'AUDIO_CONVERSION_FAILED'
      );

      return;
    }

    if (
      convertToMp3 &&
      output.ext === '.mp3' &&
      !(await looksLikeMp3(output.path))
    ) {
      await release();

      sendError(
        res,
        500,
        'The audio conversion produced an invalid MP3 file. Please try again.',
        'INVALID_MP3'
      );

      return;
    }

    const filename = sanitizeFilename(output.name);
    const notice = buildNotice(
      kind,
      convertToMp3,
      tools
    );

    res.status(200);

    res.setHeader(
      'Content-Type',
      contentTypeFor(output.name)
    );

    res.setHeader(
      'Content-Length',
      String(output.size)
    );

    res.setHeader(
      'Content-Disposition',
      contentDisposition(filename)
    );

    res.setHeader('Cache-Control', 'no-store');

    if (notice) {
      res.setHeader('X-ClipFlow-Notice', notice);
    }

    fileStream = fs.createReadStream(output.path);

    fileStream.on('error', (error) => {
      console.error(
        `[download] read error: ${error.code || 'unknown error'}`
      );

      res.destroy(error);
    });

    fileStream.pipe(res);
  } catch (error) {
    console.error(
      `[download] unexpected error: ${error.code || error.name || 'unknown'}`
    );

    await release();

    if (res.headersSent) {
      res.destroy();
    } else {
      sendError(
        res,
        500,
        'Unexpected server error. Please try again.',
        'SERVER_ERROR'
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Fallback routes and error handler
// ---------------------------------------------------------------------------

app.use((_req, res) => {
  sendError(
    res,
    404,
    'Endpoint not found.',
    'NOT_FOUND'
  );
});

app.use((error, _req, res, _next) => {
  if (error && error.type === 'entity.parse.failed') {
    sendError(
      res,
      400,
      'Request body must be valid JSON.',
      'INVALID_JSON'
    );

    return;
  }

  if (error && error.type === 'entity.too.large') {
    sendError(
      res,
      413,
      'Request body is too large.',
      'BODY_TOO_LARGE'
    );

    return;
  }

  console.error(
    `[server] unhandled error: ${error && error.name ? error.name : 'unknown'}`
  );

  sendError(
    res,
    500,
    'Unexpected server error.',
    'SERVER_ERROR'
  );
});

// ---------------------------------------------------------------------------
// Startup and shutdown
// ---------------------------------------------------------------------------

detectTools(true)
  .then((tools) => {
    console.log(
      `[startup] node: ${process.version} (${process.platform}/${process.arch})`
    );

    console.log(
      `[startup] yt-dlp: ${tools.ytDlp.version || 'NOT AVAILABLE'} (${tools.ytDlp.path || 'not found'})`
    );

    if (tools.ffmpeg.available) {
      console.log(
        `[startup] ffmpeg: ${tools.ffmpeg.version} (${tools.ffmpeg.path})`
      );

      console.log(
        `[startup] ffmpeg libmp3lame: ${tools.ffmpeg.mp3Encoder ? 'yes' : 'NO - MP3 conversion disabled'}`
      );
    } else {
      console.error(
        '[startup] ffmpeg: NOT AVAILABLE - merging and MP3 conversion are disabled'
      );
    }

    if (tools.deno.available) {
      console.log(
        `[startup] deno: ${tools.deno.version} (${tools.deno.path})`
      );
    } else {
      console.warn(
        '[startup] deno: NOT AVAILABLE - YouTube challenge solving may fail'
      );
    }

    console.log(
      `[startup] max concurrent downloads: ${MAX_CONCURRENT_DOWNLOADS}`
    );

    console.log(
      `[startup] verbose yt-dlp logging: ${YTDLP_VERBOSE ? 'on' : 'off'}`
    );
  })
  .catch((error) => {
    console.error(
      `[startup] tool detection failed: ${error.code || error.name || 'unknown'}`
    );
  });

startPotProvider();

setTimeout(() => {
  lastDiagnosticsAt = Date.now();

  runDiagnostics()
    .then((report) => {
      console.log(
        `[startup-diagnostics] ${report.diagnosis}`
      );

      if (report.debugExcerpt.length > 0) {
        console.log(
          `[startup-diagnostics:debug]\n  ${report.debugExcerpt.join('\n  ')}`
        );
      }
    })
    .catch((error) => {
      console.error(
        `[startup-diagnostics] failed: ${error.code || error.name || 'unknown'}`
      );
    });
}, 20 * 1000).unref();

sweepStaleTempDirs();

setInterval(
  sweepStaleTempDirs,
  TEMP_SWEEP_INTERVAL_MS
).unref();

const server = app.listen(PORT, HOST, () => {
  console.log(
    `[server] ClipFlow listening on ${HOST}:${PORT}`
  );
});

server.timeout = 0;

function shutdown(signal) {
  console.log(
    `[server] ${signal} received, shutting down`
  );

  potProvider.stopping = true;

  if (potProvider.child) {
    killChild(potProvider.child);
  }

  for (const activeChild of activeChildren) {
    killChild(activeChild);
  }

  server.close(() => process.exit(0));

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error(
    `[process] unhandled rejection: ${
      reason && reason.name ? reason.name : 'unknown'
    }`
  );
});
