# syntax=docker/dockerfile:1
FROM public.ecr.aws/amazonlinux/amazonlinux:2023.12.20260918.0-minimal@sha256:68b1e82cd69ade271c092bc1959fa6fc820945d0c8dbb7a88cf6c1824a184688 AS base

# Pin the OS snapshot and Node RPM; keep the RPM database for vulnerability scans.
RUN dnf install -y --releasever=2023.12.20260918 --setopt=install_weak_deps=0 \
      nodejs22-22.23.2-1.amzn2023.0.2 nodejs22-full-i18n-22.23.2-1.amzn2023.0.2 \
      nodejs22-npm-10.9.8-1.22.23.2.1.amzn2023.0.2 shadow-utils \
    && dnf clean all \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --create-home --shell /bin/bash node

FROM base AS dependencies

WORKDIR /app
RUN npm-22 install --global --ignore-scripts pnpm@10.15.0
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
