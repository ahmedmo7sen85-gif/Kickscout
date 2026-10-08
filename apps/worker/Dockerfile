# Background video worker: Node 22 + ffmpeg. Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t kickscout-worker .
# Runs anywhere that runs a container (Fly.io, Railway, Render...). It needs no inbound port.

FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @fp/worker...
COPY packages/db packages/db
COPY packages/domain packages/domain
COPY apps/worker apps/worker
RUN pnpm --filter @fp/worker... build \
 && rm -rf node_modules packages/*/node_modules apps/*/node_modules \
 && pnpm install --prod --frozen-lockfile --offline --filter @fp/worker...

FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe WORK_DIR=/tmp
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/db/package.json packages/db/
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/node_modules packages/db/node_modules
COPY --from=build /app/packages/domain/package.json packages/domain/
COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/apps/worker/package.json apps/worker/
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/worker/node_modules apps/worker/node_modules
USER node
# tini forwards SIGTERM to node (graceful shutdown finishes jobs in flight) and reaps ffmpeg children.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/worker/dist/main.js"]
