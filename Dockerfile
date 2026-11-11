FROM oven/bun:1.3
# ffmpeg decodes catalog tracks once, on first play, to precompute the
# tape's spectrogram fingerprints (server/fingerprint.ts). Playback
# itself never touches it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN bun install
RUN bun run build
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "standalone/server.ts"]
