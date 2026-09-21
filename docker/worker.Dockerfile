# syntax=docker/dockerfile:1
FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS base

FROM base AS dependencies

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
COPY package.json pnpm-lock.yaml ./
# Install in Linux so platform-specific optional dependencies match the image.
RUN pnpm install --prod --frozen-lockfile

FROM base AS worker

ENV NODE_ENV=production WORKER_CONTROL_SOCKET=/tmp/wallie-worker/control.sock
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node LICENSE package.json tsconfig.json ./
COPY --chown=node:node scripts/install-crash-handlers.mjs scripts/register-server-only.mjs scripts/worker-control.mjs ./scripts/
COPY --chown=node:node src ./src

USER node
STOPSIGNAL SIGTERM
CMD ["node", "--import", "./scripts/install-crash-handlers.mjs", "--import", "./scripts/register-server-only.mjs", "--import", "tsx", "src/worker/index.ts"]
