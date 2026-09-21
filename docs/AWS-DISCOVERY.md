# AWS staging discovery

**Collect regional inventory before choosing the database and sandbox infrastructure.** No resources are created or changed.

## Access

- Node 22 and AWS CLI v2 with an authenticated non-root profile, such as `wallie-staging`.
- Keep credentials in the AWS CLI session; no AWS keys in `.env`, Git, or chat.
- This policy permits seven read actions in one account and region. Deployment permissions come later.

From the repository root, replace the example account and region:

```bash
umask 077
mkdir -p .wallie/aws
WALLIE_AWS_ACCOUNT_ID=123456789012
WALLIE_AWS_REGION=us-west-2
node scripts/inspect-aws-staging.mjs policy \
  --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$WALLIE_AWS_REGION" \
  > .wallie/aws/discovery-policy.json
```

Policy rendering is offline. Add the generated policy once using the AWS console:

1. Sign in as an administrator; for the initial personal-account setup, use the existing root console session.
2. Open **IAM → Users → wallie-local → Permissions → Add permissions → Create inline policy**.
3. Choose **JSON** and replace the editor contents with `.wallie/aws/discovery-policy.json`.
4. Choose **Next**, name the policy **WallieStagingDiscovery**, and choose **Create policy**.
5. Keep **SignInLocalDevelopmentAccess** attached. Sign out of root; use `wallie-local` for CLI login.

See [AWS inline-policy instructions](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_manage-attach-detach.html).

## Inspect

```bash
umask 077
node scripts/inspect-aws-staging.mjs inspect \
  --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$WALLIE_AWS_REGION" \
  --profile wallie-staging \
  > .wallie/aws/discovery-report.json
```

- STS verifies the expected account and rejects root before regional reads. Expired session: run `aws login --profile wallie-staging`.
- Any API failure returns an error and withholds the report; an empty result remains distinct from access denied.
- AWS CLI pagination stays enabled. `.wallie/` is ignored by Git; keep the account, VPC inventory, and generated policy local.
- Optional `--runner-instance-type` and `--db-instance-class` override the probe defaults `m7i.large` and `db.t4g.medium`. These are metadata candidates, not production sizing decisions.

## Report

| Inventory                           | What it tells us                                                            |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Standard Availability Zones         | Candidate zones for the staging network                                     |
| Existing VPC IDs and CIDRs          | Address ranges to avoid when planning a dedicated VPC                       |
| PostgreSQL versions                 | Available versions matching `supabase/config.toml` (currently major 17)     |
| Orderable database options          | Candidate class/version combinations, AZs, Multi-AZ and encryption support  |
| EC2 instance features and offerings | Architecture, CPU/memory, advertised virtualization features, candidate AZs |
| Standard EC2 On-Demand vCPU quota   | Applied account limit; **not remaining quota or a capacity guarantee**      |

## Permission scope

- Six [EC2](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html) / [RDS](https://docs.aws.amazon.com/service-authorization/latest/reference/list_rds.html) describe actions require `Resource: "*"`; the template constrains the requesting account and region.
- [`servicequotas:GetServiceQuota`](https://docs.aws.amazon.com/service-authorization/latest/reference/list_service-quotas.html) is restricted to this account's regional `ec2/L-1216C47A` quota ARN.
- [`sts:GetCallerIdentity`](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html) needs no separate permission. The policy grants no provisioning, IAM administration, secret access, or object reads.

## Qualification still required

- **Database:** Supabase roles/extensions, migrations, Auth, RLS/RPCs, Storage, Realtime replication, failover, and restore on the actual database.
- **Sandboxes:** supported Daytona deployment, in-account controller/runners/snapshots/logs, real stage execution, network/IAM isolation, cleanup, and support terms.
- **Deployment:** available capacity, cost, network layout, remaining quotas, and narrowly scoped deployment permissions.

Successful discovery establishes inventory only. Continue with the [AWS deployment plan](AWS_VPC_DEPLOYMENT_PLAN.md).
