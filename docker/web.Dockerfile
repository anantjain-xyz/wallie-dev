# syntax=docker/dockerfile:1
FROM public.ecr.aws/amazonlinux/amazonlinux:2023.12.20260918.0-minimal@sha256:68b1e82cd69ade271c092bc1959fa6fc820945d0c8dbb7a88cf6c1824a184688 AS base

# Pin the OS snapshot and Node RPM; keep the RPM database for vulnerability scans.
RUN dnf install -y --releasever=2023.12.20260918 --setopt=install_weak_deps=0 \
      nodejs22-22.23.2-1.amzn2023.0.2 nodejs22-full-i18n-22.23.2-1.amzn2023.0.2 \
      nodejs22-npm-10.9.8-1.22.23.2.1.amzn2023.0.2 shadow-utils \
    && dnf clean all \
    && groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --create-home --shell /bin/bash node

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS dependencies
RUN npm-22 install --global --ignore-scripts pnpm@10.15.0
COPY package.json pnpm-lock.yaml ./

FROM dependencies AS build
RUN pnpm install --frozen-lockfile
COPY middleware.ts next.config.ts postcss.config.mjs tsconfig.json ./
COPY src ./src
COPY public ./public
# No installation URLs, keys, or credentials are needed for the build.
RUN pnpm build && rm -rf .next/cache

FROM dependencies AS production-dependencies
# Keep Linux optional dependencies, including SWC, sharp, and the Cursor SDK.
RUN pnpm install --prod --frozen-lockfile

FROM base AS web
ENV NODE_ENV=production PORT=3000
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node LICENSE package.json next.config.ts tsconfig.json ./
# next start reloads this configuration at startup, including the exact avatar
# origin allowlist. Standalone output would freeze it at build time.
COPY --chown=node:node src/lib/storage/image-optimizer-config.ts ./src/lib/storage/

USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
