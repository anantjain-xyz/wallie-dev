# Publish staging images

**Build and smoke-test one image, then upload that exact image to ECR.** Run after review and merge. The default flow does not sign; [optional signing](AWS-IMAGE-SIGNING.md) adds strict verification. Neither flow approves deployment.

```mermaid
flowchart LR
    git["Merged Git revision"] --> archive["Clean source archive"]
    archive --> build["Build once · linux/amd64"]
    build --> smoke["Smoke-test image ID"]
    smoke --> push["Push unique immutable tag"]
    push --> digest["Verify registry digest + image identity"]
    digest --> scan["Require completed basic scan"]
    scan --> receipt["Private receipt · not deployable"]
```

| Guard       | Behavior                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------ |
| Source      | Full commit SHA in an isolated fetch of Wallie `main`; archive without local Git overrides       |
| Image       | Fixed Linux AMD64, non-root, revision label; no rebuild after smoke                              |
| Destination | Expected account/region and exact owned web or worker repository                                 |
| Tag         | Full SHA + platform + unique build ID; existing tags are never overwritten                       |
| Scan        | Effective BASIC scan-on-push; fail on incomplete/failed scans or High/Critical findings          |
| Credentials | Validated expiring session credentials; ECR token via stdin into disposable Docker configuration |

- Requires a local Docker Unix socket and AMD64 execution support. Apple Silicon uses emulation; builds can take longer.
- Source fetching and archiving use fresh Git metadata, with replacement objects and local/global archive attributes disabled. Local untracked/ignored files do not enter the source archive. Container configuration and application secrets are supplied later, at runtime.
- BuildKit attestations are disabled for this initial single-image flow. Provenance, language-package scanning, and GitHub OIDC remain later PRs.

## Prepare access

Prerequisites: Node.js 22, Git, Docker with Buildx, AWS CLI v2 with temporary login, and the deployed [staging registry](AWS-STAGING-REGISTRY.md).

```sh
umask 077
mkdir -p .wallie/aws
export AWS_PROFILE=wallie-staging
export AWS_REGION=us-west-2
WALLIE_AWS_ACCOUNT_ID='<your-12-digit-account-id>'
node scripts/prepare-aws-image-publishing.mjs policy --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" > .wallie/aws/image-publishing-policy.json
```

- In IAM, create customer-managed **WallieStagingImagePublishing** from that file and attach it to the temporary-login identity.
- Grants uploads and verification reads for the two exact owned repositories. Authentication and registry scan-mode reads require `Resource: "*"`, constrained to the account/region.
- This policy grants no image/repository deletion, setting changes, manual scans, signing, IAM administration, or layer downloads. Existing infrastructure policies remain separate grants.
- The selected profile must provide expiring session credentials; long-lived access-key profiles are rejected. [AWS CLI temporary login](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html)
- Refresh after build/push and as needed before each AWS request. Require over 150 seconds remaining: a two-minute timeout plus a 30-second margin. Recheck after identity validation; stop if renewal cannot supply enough time.
- Expired-token responses get one identity-checked retry; Docker uploads are never retried automatically.
- Every replacement must match the initial account, partition, and principal. A refreshed role session may change its session name; its role ARN and unique role ID must match. Credentials remain in memory.
- AWS credentials and provider variables are removed from Git, Docker/Buildx, and smoke-test environments. The selected profile configuration is used only by the AWS credential resolver.
- Inherited `DOCKER_CONTENT_TRUST*` settings and passphrases are removed from those environments, keeping Docker qualification independent of local [Docker signing settings](https://docs.docker.com/engine/security/trust/).
- No AWS keys in `.env`, GitHub secrets, build arguments, or Docker images.

## Publish one component

```sh
git fetch origin main
WALLIE_IMAGE_REVISION="$(git rev-parse origin/main)"
node scripts/publish-aws-image.mjs \
  --component web \
  --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" \
  --revision "$WALLIE_IMAGE_REVISION" --profile "$AWS_PROFILE"
```

- Repeat with `--component worker` for the same revision. Each command builds and tests independently using the existing [web](WEB-CONTAINER.md) or [worker](WORKER-CONTAINER.md) smoke checks.
- The publisher independently fetches `main` and rejects unmerged revisions, root credentials, wrong destinations, mutable tags, remote Docker daemons, or incompatible scanning settings.
- It checks effective scanning with `BatchGetRepositoryScanningConfiguration`; it never changes account-wide scan settings. BASIC scans cover OS packages only. [AWS scanning scope](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html)
- The registry manifest must reference the tested local image configuration and match its reported digest. Future deployments use **`repository@sha256:…`**, never a mutable tag.
- Optional `--signing-profile-version` invokes the [gated signing workflow](AWS-IMAGE-SIGNING.md#publish-with-signing) after qualification; it cannot sign directly from an old receipt.

## Read the result

- Receipt: `.wallie/aws/image-<component>-<revision>-linux-amd64-<build-id>.json`, mode `0600`.
- Records source revision, tested image ID and config digest, registry digest, upload status, scan findings and freshness. The default flow records `signed: false`; optional signing adds [attempt/verification states](AWS-IMAGE-SIGNING.md#read-the-result). `deployable` always remains `false`.
- Successful exit requires a completed scan with no High/Critical findings. Lower severities remain in the receipt; success is **not** full vulnerability clearance or deployment approval.
- A completed scan must be newer than the upload start and no later than the current time. Keep the host clock synchronized. Stale findings remain unverified while the publisher waits, then fail if no fresh scan arrives. Repeated digests may not receive a new scan because BASIC scanning limits each image to once per 24 hours. [AWS scan limits](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-basic.html)
- Scanning is checked **after upload**. A failed scan leaves the image in ECR and returns failure; inspect the receipt. An interrupted/failed upload may also leave an image or layers; verify its tag before retrying.
- Retry creates a new build/tag. No automatic rollback, image deletion, or expiration policy; storage can accumulate. [ECR usage charges](https://aws.amazon.com/ecr/pricing/)
- Next gates: release provenance, broader package scanning, Linux CI tooling and GitHub OIDC publishing, then deployment qualification. No compute or production cutover occurs here.

## Verification boundary

- Local tests exercise command ordering and failure handling; real Docker smoke checks exercise both runtimes.
- **Live qualification · September 22, 2026 (UTC):** both images passed runtime smoke checks, uploads, manifest/config verification, fresh ECR BASIC scans, and strict Notation verification, including online revocation checks.

| Image  | Merged source | ECR findings (all severities) | Signature                  |
| ------ | ------------- | ----------------------------- | -------------------------- |
| Web    | `fc605b36`    | 0                             | Strict verification passed |
| Worker | `924e28b8`    | 0                             | Strict verification passed |

- **Runtime:** pinned [Amazon Linux 2023 minimal](https://docs.aws.amazon.com/linux/al2023/ug/minimal-container.html), release `2023.12.20260918`, with AWS-packaged Node 22.23.2. [AWS classifies its zlib package as unaffected](https://explore.alas.aws.amazon.com/CVE-2026-85091.html).
- The dated image digest and [versioned package repository](https://docs.aws.amazon.com/linux/al2023/ug/deterministic-upgrades-usage.html) pin the OS/runtime inputs. Keep the RPM inventory; no package metadata removal or severity exceptions.
- Web's existing signature passed verification after the scoped revocation-read policy correction; its original receipt remains unchanged, with separate verification evidence. Worker completed the publisher with `signed: true` and `signing.status: verified`.
- **Historical Debian scans:** `d2841540` had 3 Critical / 14 High findings per image; Debian 13 revision `00c0cac9` had 0 Critical / 1 High. The remaining High was zlib `CVE-2026-85091`, with Perl `CVE-2026-82560` also reported as Undefined. Those images failed qualification and received no exception.
- **Remaining gates:** provenance, language-package scanning, Linux CI tooling, GitHub OIDC publishing, and deployment qualification. These local macOS arm64 runs built Linux AMD64 images; BASIC OS scans and valid signatures do not establish complete vulnerability clearance. Both images retain `deployable: false`.
