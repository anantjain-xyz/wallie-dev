# AWS staging web milestone and replay

**September 26–27, 2026:** `aws-staging.wallie.dev` served the Wallie Next.js web container from a private ECS Fargate task behind a public HTTPS ALB. The web task reached the **existing hosted Wallie Supabase project** through a one-AZ NAT. This proved the web path only. The service was scaled from one healthy task to **0/0**; the unused PostgreSQL qualification EC2 host was stopped. The Wallie AWS staging resources were then destroyed and verified as described below. The existing hosted Supabase project, production Vercel site, and Railway worker were not cut over or deleted.

```mermaid
flowchart LR
  browser[Browser] -->|staging DNS + TLS| alb[Public ALB]
  alb -->|HTTP 3000| web[Private ECS web task<br/>services-a]
  web -->|HTTPS via NAT| hosted[Existing Supabase Cloud<br/>live Wallie data]
  railway[Existing Railway worker] --> hosted
  future[Future AWS worker + Supabase + sandboxes] -. not deployed .-> web
```

| Observed on September 26                                                         | Boundary                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `https://aws-staging.wallie.dev` returned HTTP 200 with a valid TLS certificate. | The browser path and hosted web response worked; this alone does not prove login, writes, or a full session.                     |
| ECS reached 1/1 running and healthy, then 0/0 after scale-down.                  | Only the web service was launched; no AWS worker was deployed.                                                                   |
| The unused private EC2 qualification host was stopped.                           | It had no running PostgreSQL service. Stopping does not remove its EBS, endpoint, or log charges.                                |
| Supabase Auth allowed `https://aws-staging.wallie.dev/auth/confirm**`.           | The existing production project and live data remained in Supabase Cloud. `wallie.dev` and the Railway worker were not cut over. |

| Layer         | Canary                                    | Full AWS migration still needs                             |
| ------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Web           | One private Fargate task behind HTTPS ALB | Durable service, monitoring, multi-AZ rollout and rollback |
| Data and Auth | Existing hosted Supabase project          | Self-hosted API, PostgreSQL, Storage, backup and recovery  |
| Jobs          | Existing Railway worker                   | AWS worker with drain and active-job recovery              |
| Sandboxes     | Existing external providers               | In-account execution for every required use case           |
| Edge/egress   | Staging DNS and one-AZ NAT                | Production cutover, WAF, reviewed egress and availability  |

## Teardown result · September 27, 2026 UTC

Five saved, refreshed Terraform destroy plans applied with **0 additions, 0 changes, and 94 deletions**. The plans used isolated local copies of the checked-in roots to relax `prevent_destroy`; no teardown-only configuration was committed. Each root's remote state then contained **0 resources**.

| Scope                      | Removed                                                                                                | AWS readback                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Application · 15 resources | ECS service/cluster, ALB/listener/target, ACM certificate, logs, security groups, secret containers    | Staging ALB absent; no active `wallie-staging` task definitions |
| PostgreSQL · 14 resources  | Stopped qualification EC2 instance, root/data EBS, SSM endpoints, host role/profile and session logs   | No EBS volumes or snapshots in `us-west-2`                      |
| Backup · 7 resources       | Empty Object Lock backup bucket and its configuration                                                  | Bucket absent; it had 0 object versions and 0 delete markers    |
| Registry · 4 resources     | Three ECR repositories and signing profile, after deleting 13 image manifests                          | No `wallie-staging/*` ECR repositories                          |
| Network · 54 resources     | Staging VPC, NAT, public IPv4, interface/gateway endpoints, subnets, routes and security groups        | Staging VPC, ALB, public IP and VPC endpoints absent            |
| State bootstrap            | CloudFormation stack and retained bucket/policy; purged 108 state versions and 74 delete markers first | No S3 buckets remain in account `111614490109`                  |

The exclusive PostgreSQL EBS KMS key `2c9fad2d-92ab-4c2f-951c-056dedaf0bbb` is `PendingDeletion`, scheduled for **October 4, 2026, 05:31 UTC**. The web and worker runtime secrets are pending their 30-day deletion windows. [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/manage_delete-secret.html) and [AWS KMS pricing](https://aws.amazon.com/kms/pricing/) say these pending resources have no ongoing storage charge. IAM execution roles and deployment policies remain; they have no resource-hour charge and should be reviewed before a future replay.

**Operator cleanup remains:** remove the GoDaddy site CNAME `aws-staging.wallie.dev` → `wallie-staging-web-1580392154.us-west-2.elb.amazonaws.com`, remove ACM validation CNAME `_e992036994e4faf1cdda07910226c813.aws-staging.wallie.dev` → `_02fc3cf9a608b8c7e9e21dac3ecf914f.wzccmgtwzk.acm-validations.aws`, and remove the hosted Supabase Auth redirect allowlist entry `https://aws-staging.wallie.dev/auth/confirm**`. These entries now point at removed AWS resources. Keep production domain and Supabase entries. The unrelated SageMaker-tagged EFS file system `fs-c17290b9` in `us-east-2`, created in February 2020, is intentionally retained at the owner's request and continues to incur storage charges. Recheck Cost Explorer after its reporting lag to verify the Wallie charges have stopped; this account will still have EFS charges.

## Reuse the checked-in staging infrastructure

This repository contains **five separate Terraform roots**, not a turnkey self-hosted Wallie installation. Use Terraform 1.16.3, the checked-in AWS provider 6.65.0 lock files, Node.js 22, a non-root AWS identity, and a commercial-region account you control. Keep backend files, plans, IDs, and secret metadata in ignored `.wallie/aws/`; never put credentials or secret values in Git.

1. **Own the inputs.** Select an AWS account, region, two distinct AZs, non-overlapping private `/16` CIDR, domain/DNS operator, and an isolated Supabase project for a new canary. Confirm them with `aws sts get-caller-identity`. Do not point a replay at Wallie's hosted production project or reuse its encryption key.
2. **Parameterize before applying.** The current hosted-web path is tied to Wallie's account and domain. Change the exact guards below and their tests; replacing IDs only in a private manifest is insufficient.
3. **Bootstrap state.** Deploy the private versioned state bucket from [`infra/aws/state-bootstrap.yaml`](../infra/aws/state-bootstrap.yaml) with a reviewed CloudFormation change set. `scripts/prepare-aws-state.mjs` renders the exact-account IAM policy and backend configuration; run it with `--component` for each root so `staging/{foundation,registry,application,postgres,backup}.tfstate` use distinct keys. Follow [state bootstrap](AWS-STATE-BOOTSTRAP.md).
4. **Build the network, registry, and application foundation.** Apply [`staging-network`](../infra/aws/staging-network) in the sequence in [network foundation](AWS-STAGING-NETWORK.md): foundation and hardening, then private ECR/Logs endpoints and the S3 gateway. Apply [`staging-registry`](../infra/aws/staging-registry), publish and verify a pinned web image digest, and review its scan and signature. See [registry](AWS-STAGING-REGISTRY.md) and [image publishing](AWS-IMAGE-PUBLISHING.md). Bootstrap the [ECS service-linked role](AWS-ECS-SERVICE-ROLE.md) if absent, then apply [`staging-application`](../infra/aws/staging-application) for its cluster and log groups. Create and verify the [execution roles](AWS-EXECUTION-ROLES.md), then complete and clean up the [private image/log task smoke](AWS-PRIVATE-TASK-SMOKE.md).
5. **Prepare secrets, egress, and the web task.** Add the [empty runtime secret containers](AWS-SECRETS-FOUNDATION.md) in the application root and read back both full ARNs. Grant each execution role access to its own secret, then enable the [runtime Secrets Manager endpoint](AWS-RUNTIME-SECRET-CONNECTIVITY.md) in the network root with those ARNs. Next enable the reviewed `services-a` NAT/HTTPS option. Preserve all prior opt-in flags and exact secret ARNs in the private variables files. Create a **separate canary Supabase project**, [apply this repository's migrations](SELF_HOSTING.md#1-create-the-supabase-project), obtain that project's API keys, and generate a separate `WALLIE_ENCRYPTION_KEY`. Populate the web secret through the reviewed, interactive workflow; register one digest-pinned web task revision and verify its complete ECS readback. The checked-in [visible-web guide](AWS-VISIBLE-WEB.md) describes the original existing-project canary and its exact live-data gates; substitute the newly reviewed origin and credential contract after parameterization.
6. **Publish HTTPS in stages.** Request the staging ACM certificate, create only its exact validation CNAME at your DNS provider, and confirm `ISSUED`. Apply the ALB and ECS service with desired count **zero**, then review a separate plan raising it to **one**. Test the ALB with staging SNI/Host before publishing the site CNAME. Keep the production hostname and site URL untouched.

The [`staging-postgres`](../infra/aws/staging-postgres) root provisions a private qualification host and EBS volume; [`staging-backup`](../infra/aws/staging-backup) provisions an initially empty, upload-blocked bucket. Neither deploys PostgreSQL, Supabase Auth/Data API/Realtime/Storage, an AWS worker, or an in-account sandbox. Those remain [migration-plan](AWS_VPC_DEPLOYMENT_PLAN.md) work.

| Input or current fixed identifier                                             | Where to review for a new account                                                                                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account `111614490109`, region `us-west-2`, operator `wallie-local`           | Terraform `aws_account_id`/`aws_region` inputs; hosted-web secret/grant helpers; visible-web grant renderer. Other account-aware renderers take flags.                            |
| Host `aws-staging.wallie.dev`                                                 | `staging-application/visible-web-variables.tf`, hosted origin in `prepare-aws-app-task-definition.mjs`, ACM domain in `prepare-aws-visible-web-grant.mjs`, DNS and Auth callback. |
| Existing web secret full ARN                                                  | `prepare-aws-hosted-web-secret-grant.mjs`, `populate-aws-hosted-web-secret.mjs`, private manifest and exact network/role grants. Generate a secret in your own account.           |
| `wallie-staging` cluster, repositories, task family, policies, tags, and logs | Terraform roots, renderers, policy templates, and tests. Keep names only when they are unused in your account; parameterize them for parallel installations.                      |

### Replay verification checklist

- [ ] Caller identity and each Terraform provider `allowed_account_ids` match the intended account/region; each deployed root has its own backend key and lock.
- [ ] Saved, untargeted Terraform plans show only reviewed changes; after apply, full plans exit **0**. Read back live AWS resources, not only Terraform outputs.
- [ ] Private web task has no public IP, exact image digest/task revision/secret version, the reviewed two egress security groups plus ALB ingress group, and only the intended Supabase project URL.
- [ ] ECS service reaches **1/1**; task/container are `RUNNING`/`HEALTHY`; ALB target is healthy; web logs show readiness; the read-only Supabase Data API health query succeeds.
- [ ] ACM is `ISSUED`; staging SNI/Host returns HTTP 200 over valid HTTPS; browser configuration contains the intended public Supabase origin/key; staging DNS points only to the reviewed ALB.
- [ ] Auth redirect allowlist includes the intended staging callback pattern, with production entries unchanged; test sign-in and read-only dashboard access separately. Keep job submission disabled until an AWS worker and isolated data path exist.
- [ ] After the canary, remove the staging site CNAME, scale the ECS service to **0/0**, and confirm no running or pending tasks or healthy ALB targets.

## Teardown order and protections

**Completed for Wallie staging on September 27, 2026 UTC.** Use this order when retiring a replay. A zero-task ECS service still leaves the ALB, NAT/EIP, interface endpoints, EBS, ECR images, logs, secrets, and S3 object versions billable. Use an exact-account administrator teardown grant; deployment policies intentionally omit many delete actions. Preserve private state and a reviewed inventory until all resources it tracks are gone.

1. **Stop traffic and compute:** remove the external staging site CNAME and the hosted Supabase Auth redirect entry; verify ECS desired/running/pending **0/0/0**, no standalone tasks, and the PostgreSQL host stopped. Decide whether any EBS data, backup versions, images, logs, or Terraform state need an encrypted export before deletion. Check for other consumers of shared keys, roles, or DNS records.
2. **Application root:** disable ALB and CloudWatch log-group native deletion protection, then remove `prevent_destroy` in a reviewed teardown change. Keep all current opt-ins and IDs in the variables file until the root is destroyed. Review and apply a saved destroy plan for the ECS service, listener, ALB, target group, certificate, web/security groups, secret containers, logs, and cluster. Deregister the manually registered task revision and retire its execution role after no task uses it.
3. **PostgreSQL and backup roots:** confirm the host has no database data and no attached consumers. Disable EC2 `disable_api_termination`, relax `prevent_destroy`, then review and destroy the stopped instance, standalone gp3 volume, SSM endpoints, host IAM resources, and session logs. Inspect **all** backup object versions, delete markers, legal holds, and Object Lock retention; an empty-looking bucket listing is insufficient. `force_destroy = false` still requires an actually empty bucket. Do not bypass unexpired retention.
4. **Registry and network roots:** delete ECR image manifests/signatures only after no task needs them; `force_delete = false` requires empty repositories. Review destroy of repositories and, unless deliberately retained, the signing profile. Destroy NAT/EIP and interface endpoints after all tasks/host are gone, then security groups, routes, subnets, and VPC. Their Terraform `prevent_destroy` guards need explicit review and removal. Confirm NAT, public IPv4, and all interface endpoints are absent in AWS, not just absent from state.
5. **State and access last:** after every deployed root is destroyed and verified, retire unused manual task definitions, execution roles, and temporary deployment policies/attachments as appropriate. Schedule deletion of an exclusive customer KMS key. The CloudFormation state bucket/policy use `DeletionPolicy: Retain`; deleting the stack **does not empty or delete the bucket**. Inspect and delete every state and lock object version/delete marker, then remove the retained bucket/policy with a separate reviewed action. Recheck regional inventory and billing after the next reporting interval.

An empty VPC shell, ECS cluster, IAM policy, or Signer profile may be useful to retain and has no resource-hour charge. If retaining Terraform-managed controls, also retain their state backend and account for its S3 versions and requests. A full no-storage teardown removes those controls and the backend after any required audit export.
