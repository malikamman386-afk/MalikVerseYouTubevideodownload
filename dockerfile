# =========================================================
# ClipFlow — Railway-ready Dockerfile
# Node 20 + FFmpeg + standalone yt-dlp (no Python needed)
# =========================================================
FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000

# ---------- System packages ----------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      curl \
 && rm -rf /var/lib/apt/lists/*

# ---------- Standalone yt-dlp binary (no Python required) ----------
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) ASSET="yt-dlp_linux" ;; \
      arm64) ASSET="yt-dlp_linux_aarch64" ;; \
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}" \
      -o /usr/local/bin/yt-dlp; \
    chmod 0755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

# ---------- App ----------
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
