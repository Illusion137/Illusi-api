FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# Sources with normalized permissions: a local lib-origin copy can carry 0700 dirs, unreadable to `node`.
FROM node:24-bookworm-slim AS source
WORKDIR /app
COPY package.json tsconfig.json ./
COPY drizzle ./drizzle
COPY lib-origin ./lib-origin
COPY src ./src
RUN chmod -R a+rX,go-w /app

FROM node:24-bookworm-slim
ENV NODE_ENV=production
# ffmpeg converts every media upload to AAC .m4a and avatars to WebP (src/services/media/transcode.ts).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* \
	&& { ffmpeg -hide_banner -encoders | grep -qE "^ A.{5} aac " || { echo "ffmpeg lacks the aac encoder"; exit 1; }; } \
	&& { ffmpeg -hide_banner -encoders | grep -qE "^ V.{5} libwebp " || { echo "ffmpeg lacks the libwebp encoder (avatars)"; exit 1; }; }
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=source /app ./
RUN mkdir -p /data/media /data/analyzer_tmp && chown -R node:node /data
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/index.ts"]
