FROM oven/bun:1.3
WORKDIR /app
COPY . .
RUN bun install
RUN bun run build
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "standalone/server.ts"]
