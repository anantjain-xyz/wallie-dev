ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

ARG TARGETPLATFORM
ARG CODEX_VERSION
ARG OPENCODE_VERSION

USER root
RUN set -eu; \
    test "$TARGETPLATFORM" = linux/amd64; \
    test "$(node -p 'process.versions.node.split(".")[0]')" = 22; \
    printf '%s\n' "$CODEX_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; \
    printf '%s\n' "$OPENCODE_VERSION" | grep -Eq '^1\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git ripgrep; \
    npm install --global --prefix /usr/local --cache /tmp/benchmark-npm-cache \
      "@openai/codex@$CODEX_VERSION" "opencode-ai@$OPENCODE_VERSION"; \
    rm -rf /tmp/benchmark-npm-cache /var/lib/apt/lists/*; \
    install -d -o node -g node /vercel/sandbox

ENV OPENCODE_DISABLE_MODELS_FETCH=1
USER node
WORKDIR /vercel/sandbox
RUN test "$(codex --version)" = "codex-cli $CODEX_VERSION" \
    && test "$(opencode --version)" = "$OPENCODE_VERSION"
