# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim

ARG YTDLP_VERSION=2026.08.19
ARG DENO_INSTALL_DIR=/usr/local

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DENO_INSTALL=${DENO_INSTALL_DIR}

# 1) System packages:
#    ffmpeg   -> merging streams into MP4, MP3 conversion (libmp3lame is built in on Debian)
#    python3  -> runs yt-dlp in an isolated virtualenv
#    curl/unzip -> needed by the Deno installer
#    tini     -> PID 1, forwards signals and reaps child processes
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip \
      python3 \
      python3-venv \
      ffmpeg \
      tini \
 && rm -rf /var/lib/apt/lists/*

# 2) Deno: the external JavaScript runtime yt-dlp uses for YouTube challenge solving.
RUN curl -fsSL https://deno.land/install.sh -o /tmp/deno-install.sh \
 && DENO_INSTALL=${DENO_INSTALL_DIR} sh /tmp/deno-install.sh \
 && rm -f /tmp/deno-install.sh

# 3) yt-dlp pinned to a known version, in an isolated virtualenv.
#    yt-dlp-ejs provides the challenge-solver scripts used with Deno.
RUN python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" yt-dlp-ejs \
 && ln -sf /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp

# 4) Verify every tool in the FINAL image. The build fails if any check fails.
RUN set -e; \
    echo "[build] node: $(node --version)"; \
    echo "[build] yt-dlp: $(yt-dlp --version)"; \
    echo "[build] ffmpeg: $(ffmpeg -version | head -n 1)"; \
    echo "[build] ffprobe: $(ffprobe -version | head -n 1)"; \
    echo "[build] deno: $(deno --version | head -n 1)"; \
    command -v ffmpeg; \
    command -v ffprobe; \
    command -v yt-dlp; \
    command -v deno; \
    ffmpeg -hide_banner -encoders | grep -q libmp3lame || { echo "[build] libmp3lame encoder missing"; exit 1; }; \
    echo "[build] libmp3lame: present"

# 5) Application dependencies.
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 6) Application code. NODE_ENV is set after npm install so npm does not warn.
COPY server.js ./
ENV NODE_ENV=production

# Run as the unprivileged node user. Downloads use /tmp, which is writable.
RUN chown -R node:node /app
USER node

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
