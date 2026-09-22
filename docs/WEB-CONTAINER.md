# Web container

- Packages the Next.js website, dashboard, and API; run the [worker](WORKER-CONTAINER.md) separately.
- Pinned Amazon Linux 2023 minimal image and Node 22.23.2 RPM, non-root user, locked Linux production dependencies.
- Builds without installation URLs or credentials. Package and Google Fonts downloads require network access during the build.
- Uses `next start` and retains its configuration files, so the same image supports different runtime installations.
- OS packages come from the fixed `2023.12.20260918` repository snapshot; RPM inventory remains available to scanners. See [image qualification](AWS-IMAGE-PUBLISHING.md#verification-boundary).

## Build and verify

```bash
docker build -f docker/web.Dockerfile -t wallie-web:local .
node scripts/check-web-container.mjs wallie-web:local
```

- Smoke runs the identical image with two sets of synthetic installation settings.
- Checks runtime metadata/public configuration, authentication requests, static assets, avatar restrictions, production fixture protection, and shutdown.
- Also checks npm, locale support, compression, sharp, Next SWC, and Cursor parser bindings in the final image.
- Uses isolated local fixtures; no AWS account, Supabase project, or real credentials.

## Run

```bash
docker run --detach --name wallie-web \
  --publish 127.0.0.1:3000:3000 \
  --env-file /secure/path/web.env \
  --restart unless-stopped --stop-timeout 60 \
  wallie-web:local
```

- Supply the [self-hosting environment](SELF_HOSTING.md#3-deploy-the-web-app-vercel), including all three public configuration variables and server secrets. Use a Docker-compatible environment file or the hosting platform's secret manager.
- Put HTTPS ingress in front of port 3000; use the public HTTPS origin for `NEXT_PUBLIC_APP_URL`.
- Node receives `SIGTERM` directly. Drain ingress before stopping a replica; the pinned Next.js release exits with status **143** after handling `SIGTERM`.
- Keep the runtime image cache writable. This image uses a local cache; shared caches, rollout coordination, and AWS ingress belong to deployment configuration.
- Keep the exact Supabase avatar origin restriction. Private-address image support remains limited to explicitly configured loopback development URLs.

See [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) and the [AWS migration plan](AWS_VPC_DEPLOYMENT_PLAN.md).
