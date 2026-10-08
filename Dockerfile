# =========================================================
# ClipFlow — Railway production Dockerfile
# Node 26 + FFmpeg + yt-dlp + EJS + BgUtil PO Token Provider
# =========================================================

FROM node:26-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
ENV HOME=/root
ENV PATH="/usr/local/bin:${PATH}"

# ---------------------------------------------------------
# System packages
# ---------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      curl \
      git \
      unzip \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------
# Install latest standalone yt-dlp
# ---------------------------------------------------------
RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64) ASSET="yt-dlp_linux" ;; \
      arm64) ASSET="yt-dlp_linux_aarch64" ;; \
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL \
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}" \
      -o /usr/local/bin/yt-dlp; \
    chmod 0755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

# ---------------------------------------------------------
# Install BgUtil PO Token Provider 2.0.0
# ---------------------------------------------------------
RUN set -eux; \
    git clone --depth 1 --branch 2.0.0 \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
      /opt/bgutil-ytdlp-pot-provider; \
    cd /opt/bgutil-ytdlp-pot-provider/server; \
    npm ci --include=dev --no-audit --no-fund; \
    npx tsc; \
    npm prune --omit=dev; \
    mkdir -p /root/yt-dlp-plugins/bgutil-ytdlp-pot-provider; \
    cp -r /opt/bgutil-ytdlp-pot-provider/plugin/* \
      /root/yt-dlp-plugins/bgutil-ytdlp-pot-provider/

# ---------------------------------------------------------
# Enable yt-dlp JavaScript runtime + EJS
# Official yt-dlp executable already bundles yt-dlp-ejs.
# ---------------------------------------------------------
RUN printf '%s\n' \
    '--js-runtimes' \
    'node:/usr/local/bin/node' \
    '--extractor-args' \
    'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416' \
    > /root/yt-dlp.conf

# ---------------------------------------------------------
# Application
# ---------------------------------------------------------
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./

# ---------------------------------------------------------
# Startup script
# Starts PO-token provider first, then ClipFlow
# ---------------------------------------------------------
RUN cat > /usr/local/bin/start-clipflow.sh <<'EOF'
#!/bin/sh
set -eu

echo "[startup] Starting BgUtil PO Token Provider..."

node /opt/bgutil-ytdlp-pot-provider/server/build/main.js \
  --host 127.0.0.1 \
  --port 4416 \
  > /tmp/bgutil-provider.log 2>&1 &

BGUTIL_PID=$!

cleanup() {
  kill "$BGUTIL_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

i=0
while ! curl -fsS http://127.0.0.1:4416/ >/dev/null 2>&1; do
  i=$((i + 1))

  if [ "$i" -ge 30 ]; then
    echo "[startup] BgUtil provider did not start."
    cat /tmp/bgutil-provider.log || true
    exit 1
  fi

  sleep 1
done

echo "[startup] BgUtil PO Token Provider ready."
echo "[startup] Starting ClipFlow..."

exec node /app/server.js
EOF

RUN chmod +x /usr/local/bin/start-clipflow.sh

EXPOSE 3000

CMD ["/usr/local/bin/start-clipflow.sh"]
