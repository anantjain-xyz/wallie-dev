# syntax=docker/dockerfile:1
FROM node:22.23.2-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS dependencies
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
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
