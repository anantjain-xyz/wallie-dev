# AWS staging image registry

**Manage three private ECR repositories and one image-signing profile.** Deploy after review and merge. The existing staging installation adds only the empty Supabase PostgreSQL repository; image mirroring is a later batch.

```mermaid
flowchart LR
    build["Tested container builds"] -. publish .-> web["ECR · wallie-staging/web"]
    build -. publish .-> worker["ECR · wallie-staging/worker"]
    upstream["Pinned Supabase PostgreSQL image"] -. later mirror .-> dbimage["ECR · wallie-staging/supabase-postgres"]
    web -. pull by digest .-> ecs["Later: ECS services"]
    worker -. pull by digest .-> ecs
    dbimage -. later pull by digest .-> database["Future PostgreSQL host"]
    terraform["Registry Terraform root"] --> signer["AWS Signer · profile only"]
    terraform --> state[("S3 · staging/registry.tfstate")]
```

| Setting    | Value                                                                    |
| ---------- | ------------------------------------------------------------------------ |
| Image tags | Immutable, no exclusions                                                 |
| Encryption | AES-256, managed by ECR                                                  |
| Scanning   | Repository basic scan-on-push enabled                                    |
| Deletion   | Terraform `prevent_destroy`; `force_delete = false`; no IAM delete grant |
| State      | Existing private bucket, separate registry key and lock                  |

- This Terraform root configures repositories and the signing profile. It does not push the [locked Supabase database image](../infra/supabase/upstream.lock.json). Image publishing and signing are separate operations; no compute, lifecycle expiration, repository sharing, or account-wide scanning/signing changes.
- ECR is a regional AWS service outside the VPC. Private access from workloads needs a later endpoint/egress decision.
- Repository settings do not establish the account's effective scanning mode. Before publishing, inspect ECR **Private registry → Scanning**, verify repository coverage, and check actual findings. [Basic scanning covers OS packages; enhanced scanning also covers language packages](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning.html).

## Prepare

Prerequisites: Terraform **1.16.3**, Node.js 22, temporary AWS CLI login, and the completed [state bootstrap](AWS-STATE-BOOTSTRAP.md). Provider **6.65.0** is locked. No network outputs are needed.

```sh
umask 077
mkdir -p .wallie/aws
export AWS_PROFILE=wallie-staging
export AWS_REGION=us-west-2
WALLIE_AWS_ACCOUNT_ID='<your-12-digit-account-id>'
node scripts/prepare-aws-registry.mjs policy --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" > .wallie/aws/registry-policy.json
node scripts/prepare-aws-registry.mjs variables --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" > .wallie/aws/registry.tfvars.json
node scripts/prepare-aws-state.mjs access-policy --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" > .wallie/aws/state-access-policy.json
node scripts/prepare-aws-state.mjs backend --component registry --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" > .wallie/aws/registry.backend.hcl
aws sts get-caller-identity
```

- Confirm the intended account and non-root identity. Rendered files contain no credentials; keep plans and state private under ignored `.wallie/`.
- Existing staging: an administrator records the **WallieStagingRegistry** default version, JSON, and all attached identities. Require only `wallie-local`; stop if another identity is attached.
- Make `registry-policy.json` the new default version. The document diff must add only the third exact repository ARN to each ECR statement. Preserve the previous default for rollback; stop if the five-version limit prevents that. Read back the new default and attachments.
- `wallie-local` already has 10/10 managed-policy attachments; no new attachment is needed. The existing **WallieStagingStateAccess** policy and signing profile remain unchanged.
- Fresh installation: create **WallieStagingRegistry** from `registry-policy.json` and attach it; prepare the [state-access update](AWS-STATE-BOOTSTRAP.md) and separate [signing bootstrap policy](AWS-SIGNING-PROFILE.md#prepare-access) before planning.
- Keep the existing network backend file unchanged. The registry uses the default Terraform workspace and **`staging/registry.tfstate`**, never `staging/foundation.tfstate`.

## Check names before creating

```sh
aws ecr describe-repositories --registry-id "$WALLIE_AWS_ACCOUNT_ID" --repository-names wallie-staging/web
aws ecr describe-repositories --registry-id "$WALLIE_AWS_ACCOUNT_ID" --repository-names wallie-staging/worker
aws ecr describe-repositories --registry-id "$WALLIE_AWS_ACCOUNT_ID" --repository-names wallie-staging/supabase-postgres
```

- First deployment: require **`RepositoryNotFoundException` for each name**. Existing staging: confirm web and worker match Terraform state and require `RepositoryNotFoundException` for `supabase-postgres` after the policy update. Access errors are not evidence of absence. Stop if the new name already exists; do not import or retag it without separate review.
- IAM is limited to those three exact names, account, region, and ownership tag. ECR has no create-only tagging condition: initial tagging also permits claiming an untagged repository at any allowed name. The absence check is required.
- The grant permits changing scanning and tag-mutability settings on owned repositories; Terraform sets their reviewed values. It grants no login token, image push/pull, repository/image deletion, IAM, or registry-wide configuration access.

- Inspect existing managed repositories and Terraform state. Complete the [signing profile absence check](AWS-SIGNING-PROFILE.md#check-the-name) before its first creation.

## Plan, review, apply

```sh
WALLIE_AWS_FILES="$PWD/.wallie/aws"
terraform -chdir=infra/aws/staging-registry init -lockfile=readonly -backend-config="$WALLIE_AWS_FILES/registry.backend.hcl"
terraform -chdir=infra/aws/staging-registry plan -var-file="$WALLIE_AWS_FILES/registry.tfvars.json" -out="$WALLIE_AWS_FILES/registry.tfplan"
terraform -chdir=infra/aws/staging-registry show "$WALLIE_AWS_FILES/registry.tfplan"
```

- Fresh installation: **four additions, no changes, no deletions** (three repositories + one profile).
- Existing two-repository installation with the profile: **one addition, no changes, no deletions** (empty PostgreSQL repository only).
- Check exact names, account/region, encryption, scanning, immutable tags, ownership tags, and the profile settings in the [signing guide](AWS-SIGNING-PROFILE.md).
- After reviewing the saved plan:

```sh
terraform -chdir=infra/aws/staging-registry apply "$WALLIE_AWS_FILES/registry.tfplan"
terraform -chdir=infra/aws/staging-registry output
aws ecr describe-repositories --registry-id "$WALLIE_AWS_ACCOUNT_ID" --repository-names wallie-staging/web wallie-staging/worker wallie-staging/supabase-postgres
terraform -chdir=infra/aws/staging-registry plan -var-file="$WALLIE_AWS_FILES/registry.tfvars.json" -detailed-exitcode
```

- Verify repository and [signing profile readback](AWS-SIGNING-PROFILE.md#verify-and-remove-bootstrap-access) match the plan; the final plan must exit **0**. CI mocks do not prove live IAM or effective scanning. On a fresh installation, detach the signing bootstrap grant afterward, before image publishing.
- No fixed repository charge; stored images and applicable transfer incur [ECR usage charges](https://aws.amazon.com/ecr/pricing/). Empty repositories add no image storage; Terraform state retains its separate S3 usage.
- Continue with [manual web/worker image publishing](AWS-IMAGE-PUBLISHING.md) and the [signing workflow](AWS-IMAGE-SIGNING.md). Those two images passed live scan/signature qualification. Mirroring, scanning, and qualifying the pinned Supabase PostgreSQL image are separate work; this repository starts empty. Retention must preserve deployed and rollback images; no expiration policy is added here.
