# Prepare a qualified benchmark replay image

Live replay uses a project-owned Vercel Sandbox image pinned by its registry digest. The image includes the exact Codex and OpenCode CLIs recorded by the benchmark candidates. The [benchmark suite architecture](benchmark-suites.md) covers captured tasks and the experiment matrix.

## Build and check the image

1. Choose the exact CLI versions from successful capability checks for the factory repository, Vercel connection, and dated OpenAI model. Use OpenCode 1, which installs as `opencode-ai`. The candidate checks must report the same versions as the image. [Codex CLI installation](https://github.com/openai/codex#installing-codex-cli) · [OpenCode 1 package source](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/package.json)
2. Build locally for `linux/amd64`. The [Dockerfile](../../scripts/benchmark-replay.Dockerfile) uses the official Node 22 Debian image with Git, the system CA bundle, and ripgrep for offline source searches. Pass `--build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:<digest>` to pin the base across builds. [Vercel Sandbox images](https://vercel.com/docs/sandbox/concepts/images) · [Node Docker image](https://github.com/nodejs/docker-node) · [OpenCode ripgrep resolution](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/file/ripgrep.ts#L122-L138)

   ```bash
   CODEX_VERSION='<exact Codex version, e.g. 0.88.0>'
   OPENCODE_VERSION='<exact OpenCode 1 version, e.g. 1.2.27>'

   docker buildx build --platform linux/amd64 --load \
     --build-arg "CODEX_VERSION=$CODEX_VERSION" \
     --build-arg "OPENCODE_VERSION=$OPENCODE_VERSION" \
     --tag wallie-benchmark-replay:local \
     - < scripts/benchmark-replay.Dockerfile
   ```

3. Run the image with networking disabled. Record the version and SHA-256 for each resolved executable. The worker resolves the same entrypoint with `readlink -f`, hashes it, and runs that exact path. Hash the npm launcher when it is the resolved entrypoint. The registry digest pins the launcher and its packaged dependencies together.

   ```bash
   CLI_PROOF='
     test -w /vercel/sandbox
     cd /tmp
     node --version
     git --version
     rg --version
     for cli in codex opencode; do
       executable=$(readlink -f "$(command -v "$cli")")
       printf "%s\n" "$executable"
       sha256sum "$executable"
       "$executable" --version
     done
   '
   docker run --rm --platform linux/amd64 --network none wallie-benchmark-replay:local sh -ec "$CLI_PROOF"
   ```

## Publish and pin the image

Use the Vercel project configured in the workspace's Vercel Sandbox connection. Sign in to the Vercel CLI as an operator with registry write access. Use a unique tag for each build.

```bash
vercel link
vercel vcr login docker
IMAGE_TAG='<unique build tag>'
REGISTRY_REPOSITORY='vcr.vercel.com/<team-slug>/<project-name>/wallie-benchmark-replay'
docker tag wallie-benchmark-replay:local "$REGISTRY_REPOSITORY:$IMAGE_TAG"
docker push "$REGISTRY_REPOSITORY:$IMAGE_TAG"
docker pull --platform linux/amd64 "$REGISTRY_REPOSITORY:$IMAGE_TAG"
vercel vcr tag inspect wallie-benchmark-replay "$IMAGE_TAG"
```

Compare the push and pull digests. In Vercel, wait for the uploaded image to show **Ready**. Record the registry manifest digest as `vcr.vercel.com/<team-slug>/<project-name>/wallie-benchmark-replay@sha256:<digest>`. The local Docker image ID identifies a different object. [Vercel Container Registry](https://vercel.com/docs/container-registry#verify-an-image-before-you-use-it)

Run the same proof in a fresh Vercel sandbox after the image is ready. Compare the versions and digests against the local results. [Vercel Sandbox CLI](https://vercel.com/docs/sandbox/sdk/cli#sandbox-run)

```bash
PINNED_IMAGE="$REGISTRY_REPOSITORY@sha256:<registry manifest digest>"
sandbox run --scope '<team-slug>' --project '<project-name>' --image "$PINNED_IMAGE" \
  --network-policy deny-all --timeout 1m --rm -- sh -ec "$CLI_PROOF"
```

## Configure the live connection

| Setting                               | Where to set it                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WALLIE_BENCHMARK_LIVE_IMAGE_PROFILE` | Vercel web deployment, as one JSON object with the registry reference and CLI proofs below.                                                                    |
| `NEXT_PUBLIC_APP_URL`                 | Private Cloudflare Workerd deployment. Use the HTTPS origin of the Vercel web deployment that serves the relay.                                                |
| `WALLIE_WORKER_DISPATCH_ENABLED=true` | Workerd deployment authorized to claim live benchmark jobs.                                                                                                    |
| `WALLIE_ENCRYPTION_KEY`               | Existing workspace secret encryption setting. Use the deployment's current key on the web and worker runtimes.                                                 |
| Vercel Sandbox connection             | Workspace settings. Use the project that can pull the private VCR image and whose signed sandbox identity is accepted by the relay.                            |
| Dedicated OpenAI API key              | Factory inference connection. Provision the key through the authenticated factory endpoint. Keep it out of the image, image profile, and deployment variables. |

Deployment protection must allow the sandbox proxy to reach `/api/internal/benchmark-openai` at the configured HTTPS origin. The route verifies the signed Vercel identity on each proxied request.

```json
{
  "image": "vcr.vercel.com/<team-slug>/<project-name>/wallie-benchmark-replay@sha256:<digest>",
  "codex": { "cliVersion": "<version>", "cliDigest": "<64 lowercase hex characters>" },
  "opencode": { "cliVersion": "<version>", "cliDigest": "<64 lowercase hex characters>" }
}
```

A factory manager provisions the connection with `POST /api/workspaces/{workspaceId}/factories/{factoryId}/benchmarks/inference-connection` and `{"action":"connect","apiKey":"<dedicated OpenAI project key>"}`. The response includes the connection revision, Vercel connection revision, and image profile. Create a new connection revision and freeze a new matrix after deploying a new image profile.

Use the same dated OpenAI snapshot in both candidates. Codex uses its bare model ID. OpenCode registers `openai/<model-id>` as both its main and small model. Select Workerd for both candidates, an eligible captured task, and a `blocked` replay policy. Configure the schedule with `runnerRevision: "openai-responses-v1"`, the exact `inferenceConnectionRevision`, and a positive execution reserve.

## Verify what a trial records

- Workerd restores the exact source in a disposable sandbox. It removes Git credentials, verifies deny-all egress, then allows only the `api.openai.com` proxy rule. A one-use canary binds the signed sandbox ID. Workerd verifies denied egress before the relay can authorize inference or the CLI receives the task prompt.
- The relay forwards authorized requests to `POST https://api.openai.com/v1/responses`. It checks the requested and observed model against the frozen snapshot and retains provider usage. A successful canary consumes no provider request.
- The result retains prompt and source digests, the artifact, the private checkpoint, and the inference receipt. When the provider reports complete usage Wallie records measured token counts. Partial counts remain in the inference receipt, and the run's aggregate token usage is unavailable. Dollar cost is unavailable, so the scheduler retains the execution reserve.
