# syntax=docker/dockerfile:1
FROM node:22.23.2-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS base

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
