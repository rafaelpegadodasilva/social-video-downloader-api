FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        python3 \
        python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js ./

ENV HOST=0.0.0.0
ENV PORT=8765
ENV DOWNLOADS_DIR=/app/downloads

RUN mkdir -p /app/downloads

EXPOSE 8765

CMD ["npm", "start"]
