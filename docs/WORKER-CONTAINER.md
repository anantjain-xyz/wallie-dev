# Worker container

- Packages the existing worker for an always-on container host.
- Node 22, Debian slim, non-root user, locked production dependencies.
- Configuration is supplied when the container starts; no credentials are needed to build.
- Web hosting, Supabase, and sandbox providers remain separate services.

## Build and verify

```bash
docker build -f docker/worker.Dockerfile -t wallie-worker:local .
node scripts/check-worker-container.mjs wallie-worker:local
```

- Smoke check: actual worker registration, empty queue polling, heartbeat, and clean `SIGTERM` shutdown.
- Uses a synthetic Supabase API on an internal Docker network; no external services or real credentials.
- Checks non-root execution and exclusion of local environment files; removes its containers and network afterward.
- This verifies packaging and idle shutdown. Full pipeline and active-job recovery remain separate release checks.

## Run

```bash
docker run --detach --name wallie-worker \
  --env-file /secure/path/worker.env \
  --restart unless-stopped --stop-timeout 2700 \
  wallie-worker:local
```

- Supply the worker environment described in [Self-hosting](SELF_HOSTING.md#4-deploy-the-worker), including the existing encryption key and Supabase credentials.
- Supply a Docker-compatible environment file, or inject variables through the hosting platform's secret manager. Do not build credentials into the image.
- No inbound port is required. Allow outbound access to configured Supabase and integration endpoints.
- Node receives `SIGTERM` directly, stops claiming work, and drains active jobs while heartbeating.
- Allow **45 minutes** before forced termination; use `docker stop --time 2700 wallie-worker` for a manual stop.
- **ECS prerequisite:** Fargate allows at most a [120-second stop timeout](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html). Implement and verify draining before task termination before deploying this worker there. This image does not solve that requirement.

See [Worker operations](WORKER-OPERATIONS.md) for drain and recovery behavior.
