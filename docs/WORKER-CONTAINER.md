# Worker container

- Packages the existing worker for an always-on container host.
- Pinned Node 22.23.2/Debian 13 slim image, non-root user, locked production dependencies.
- Configuration is supplied when the container starts; no credentials are needed to build.
- Web hosting, Supabase, and sandbox providers remain separate services.

## Build and verify

```bash
docker build -f docker/worker.Dockerfile -t wallie-worker:local .
node scripts/check-worker-container.mjs wallie-worker:local
```

- Smoke check: registration, empty queue polling, direct `SIGTERM`, and pre-stop draining while heartbeats continue and work polling stops.
- Uses a synthetic Supabase API on an internal Docker network; no external services or real credentials.
- Checks non-root execution and exclusion of local environment files; removes its containers and network afterward.
- This verifies packaging and idle drain/shutdown. Unit tests cover pending claims, active jobs, and maintenance barriers; full pipeline and active-job recovery remain separate release checks.

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

## Drain before a planned stop

```bash
docker exec wallie-worker node scripts/worker-control.mjs status
docker exec wallie-worker node scripts/worker-control.mjs drain --timeout-seconds 2700 \
  && docker stop --time 120 wallie-worker
```

- `drain` exits successfully only after the **same worker** reports `drained`. It stops new claims, Cursor sign-in polling, and maintenance scheduling; already-claimed jobs finish.
- The drained worker stays alive, registered, and heartbeating until `SIGTERM`. Drain is one-way; restart to resume work.
- A failed, missing, changed-worker, or timed-out status check must abort the stop. A CLI timeout leaves the worker draining; inspect it and retry the command.
- Control uses an owner-only Unix socket; no inbound port. The image sets `WORKER_CONTROL_SOCKET=/tmp/wallie-worker/control.sock`. Outside Docker, opt in with an absolute path in a worker-owned `0700` directory; unset disables control. Give each worker its own path.
- **ECS gate:** Fargate allows at most a [120-second stop timeout](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html). Deployment tooling must drain and verify each exact old task **before** requesting replacement, scale-in, or stop. The image supplies worker control; automatic ECS rollout/scale-in protection remains to be implemented and tested.

See [Worker operations](WORKER-OPERATIONS.md) for drain and recovery behavior.
