# Mirror the locked Supabase PostgreSQL image

**Copy the reviewed Supabase PostgreSQL OCI index into the private staging ECR repository without rebuilding it.** The mirror is an image inventory step; it does not start PostgreSQL or authorize deployment.

| Item                | Required value                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source              | `docker.io/supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00` from [`upstream.lock.json`](../infra/supabase/upstream.lock.json) |
| Platform to qualify | `linux/amd64` child manifest `sha256:5a4314708484bec672de2c09653a5c01fb1c84a998564ac231b0325e2238ed5b`                                                                  |
| Destination         | `<account>.dkr.ecr.us-west-2.amazonaws.com/wallie-staging/supabase-postgres` in the reviewed account                                                                    |
| Result              | Exact index digest in ECR, fresh completed amd64 scan, private receipt with `deployable: false`                                                                         |

The lock digest identifies an **OCI index**, which also contains an arm64 image and two attestation manifests. The amd64 image configuration digest is a different identifier. Copy by the index digest with `skopeo copy --all --preserve-digests`; a Docker pull/tag/push can change the manifest digest or omit platforms. [AWS migration guidance](https://docs.aws.amazon.com/AmazonECR/latest/userguide/migrate-from-third-party.html), [Skopeo copy options](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md).

## Prepare offline

- Use Node.js 22, AWS CLI v2, and Skopeo. Select a full commit SHA already merged to `origin/main`; review its committed lock and the mirror script. The script archives that reviewed revision and reads its lock. Keep generated receipts and authentication files in ignored `.wallie/aws/` with owner-only permissions.
- The image source is the committed `@sha256` reference. The version tag is informational and must not select the source bytes. Require one `linux/amd64` child and verify the source index hash before any upload.
- Render the [image publishing policy](../infra/aws/image-publishing-policy.template.json) for the exact account and region. Its diff must add only `wallie-staging/supabase-postgres` to the existing upload and verification statements. It must not add deletion, repository configuration, IAM, or wildcard repository access.

```sh
umask 077
mkdir -p .wallie/aws
WALLIE_AWS_ACCOUNT_ID='<reviewed-12-digit-account>'
node scripts/prepare-aws-image-publishing.mjs policy \
  --account-id "$WALLIE_AWS_ACCOUNT_ID" --region us-west-2 \
  > .wallie/aws/image-publishing-policy.json
```

## Live prerequisites

1. Confirm the [registry Terraform root](AWS-STAGING-REGISTRY.md) has been applied. Read back the exact destination repository: account, region, name, `WallieStack=wallie-staging-registry`, AES-256 encryption, scan-on-push, and immutable tags with no exclusions. Check effective registry scanning is BASIC scan-on-push for this repository. Stop if the repository is absent or differs.
2. Renew the `wallie-staging` temporary login. Run `aws sts get-caller-identity` and verify the intended account and a non-root principal. Do not use a root or long-lived access-key profile.
3. `wallie-local` already occupies 10/10 managed-policy attachment slots. An administrator records the current default version, full policy document, and every attached identity of **`WallieStagingImagePublishing`**. Require only the reviewed identity, then update that policy's default version with the exact third repository ARN. Read back the version and attachments. Do not add an eleventh policy attachment.
4. Confirm the destination repository is empty, including untagged manifests, and the derived tag `upstream-sha256-<full locked index digest without sha256:>` is absent. An existing image requires inventory and review before any rerun; an access error is not evidence of absence. Keep the repository immutable and never overwrite a tag.

## Copy and verify

Run the mirror command from a networked operator machine with the reviewed account, region, merged revision, and temporary profile. It uses the locked index digest and a private disposable ECR authentication file. Do not put an ECR token in command arguments or logs.

```sh
export AWS_PROFILE=wallie-staging
export AWS_REGION=us-west-2
WALLIE_IMAGE_REVISION='<full-merged-origin-main-Git-SHA>'
node scripts/mirror-aws-postgres-image.mjs \
  --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" \
  --revision "$WALLIE_IMAGE_REVISION" --profile "$AWS_PROFILE"
```

After the upload, require all of these readbacks before accepting the receipt:

- ECR's immutable tag resolves to the **exact locked index digest**. The raw destination index hash matches the source, including its four child descriptors; the amd64 child can be fetched by its manifest digest. [ECR does not convert a manifest requested by digest](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-manifest-formats.html).
- Effective BASIC scan-on-push still covers the repository. Query `DescribeImageScanFindings` for the **amd64 child manifest**, not the index or unknown-platform attestation manifests. Require a fresh completed scan after this copy, review its findings, and block qualification for HIGH or CRITICAL counts. Current basic scanning does not report findings through `DescribeImages`. [ECR scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html).
- Save the 0600 receipt at `.wallie/aws/postgres-image-<index digest>-<run id>.json`. It records the source/index/amd64 digests, destination, scan result, `signed: false`, and `deployable: false`. Digest equality proves the copied bytes; it does not establish an upstream signature or qualify the database host.

**On a failed or partial copy, stop.** Child manifests may already exist without the final index tag. Inventory the repository, manifest digests, and scan state before a separately reviewed retry. Do not delete, retag, or automatically rerun. Separate OCI referrer artifacts are not copied by this flow; do not claim their provenance was verified. The host still needs its private ECR pull path, secret handling, storage mount, backup, and runtime qualification before PostgreSQL can run.
