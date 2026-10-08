# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim

ARG YTDLP_VERSION=2026.08.19
ARG DENO_INSTALL_DIR=/usr/local

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DENO_INSTALL=${DENO_INSTALL_DIR}

# 1) System packages: FFmpeg (merging, MP3 conversion), Python (for yt-dlp),
#    certificates (HTTPS), unzip (required by the Deno installer), tini (PID 1).
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

# 2) Deno: the recommended external JavaScript runtime for yt-dlp's YouTube
#    challenge solving. Installed to ${DENO_INSTALL_DIR}/bin/deno.
RUN curl -fsSL https://deno.land/install.sh -o /tmp/deno-install.sh \
 && DENO_INSTALL=${DENO_INSTALL_DIR} sh /tmp/deno-install.sh \
 && rm -f /tmp/deno-install.sh

# 3) yt-dlp pinned to a known version, installed into an isolated virtualenv.
#    yt-dlp-ejs provides the challenge-solver scripts used with Deno.
RUN python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" yt-dlp-ejs \
 && ln -sf /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp

# 4) Verify every binary inside the FINAL image. The build fails if any of them
#    is missing or cannot execute.
RUN set -e; \
    echo "[build] node: $(node --version)"; \
    echo "[build] yt-dlp: $(yt-dlp --version)"; \
    echo "[build] ffmpeg: $(ffmpeg -version | head -n 1)"; \
    echo "[build] deno: $(deno --version | head -n 1)"; \
    command -v ffmpeg; \
    command -v yt-dlp; \
    command -v deno

# 5) Application dependencies.
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 6) Application code. Set NODE_ENV only after npm install so npm does not
#    emit the "config production" warning.
COPY server.js ./
ENV NODE_ENV=production

# Run as the unprivileged node user. Downloads go to /tmp, which is writable.
RUN chown -R node:node /app
USER node

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
