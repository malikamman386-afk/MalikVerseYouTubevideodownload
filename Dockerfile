# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim

# Pinned versions. Check that these tags exist before building:
#   yt-dlp:      https://github.com/yt-dlp/yt-dlp/releases
#   bgutil:      https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases
# The plugin (PyPI) and the provider server (git source) must come from the same release.
ARG YTDLP_VERSION=2026.08.19
ARG BGUTIL_REF=v2.0.0
ARG BGUTIL_PLUGIN_VERSION=2.0.0
ARG DENO_INSTALL_DIR=/usr/local

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DENO_INSTALL=${DENO_INSTALL_DIR}

# 1) System packages
#    ffmpeg  -> merging streams into MP4, MP3 conversion (libmp3lame is built in on Debian)
#    git     -> fetches the PO token provider server source
#    python3 -> runs yt-dlp and the PO token plugin in an isolated virtualenv
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip \
      git \
      python3 \
      python3-venv \
      ffmpeg \
      tini \
 && rm -rf /var/lib/apt/lists/*

# 2) Deno: the external JavaScript runtime yt-dlp uses for YouTube challenge solving.
RUN curl -fsSL https://deno.land/install.sh -o /tmp/deno-install.sh \
 && DENO_INSTALL=${DENO_INSTALL_DIR} sh /tmp/deno-install.sh \
 && rm -f /tmp/deno-install.sh

# 3) yt-dlp and the bgutil PO token plugin, in an isolated virtualenv.
#    yt-dlp discovers the plugin automatically through its entry points.
RUN python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir \
      "yt-dlp[default]==${YTDLP_VERSION}" \
      yt-dlp-ejs \
      "bgutil-ytdlp-pot-provider==${BGUTIL_PLUGIN_VERSION}" \
 && ln -sf /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp

# 4) bgutil PO token provider server (Node.js), built from the matching release.
RUN git clone --depth 1 --branch "${BGUTIL_REF}" \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-src \
 && cd /opt/bgutil-src/server \
 && npm ci \
 && npx tsc \
 && npm prune --omit=dev \
 && mkdir -p /opt/bgutil \
 && mv /opt/bgutil-src/server /opt/bgutil/server \
 && rm -rf /opt/bgutil-src

# 5) Verify every component in the FINAL image. The build fails if any check fails.
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
    echo "[build] libmp3lame: present"; \
    /opt/ytdlp/bin/pip show bgutil-ytdlp-pot-provider | head -n 2; \
    test -f /opt/bgutil/server/build/main.js || { echo "[build] bgutil main.js missing"; exit 1; }; \
    echo "[build] bgutil server: /opt/bgutil/server/build/main.js present"

# 6) Application dependencies.
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 7) Application code. NODE_ENV is set after npm install so npm does not warn.
COPY server.js ./
ENV NODE_ENV=production \
    BGUTIL_MAIN=/opt/bgutil/server/build/main.js \
    BGUTIL_PORT=4416

# Run as the unprivileged node user.
RUN chown -R node:node /app
USER node

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
