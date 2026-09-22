# ECS service-linked-role bootstrap

**Create the missing account-wide ECS service-linked role before the [application foundation](AWS-APPLICATION-FOUNDATION.md). Review and merge this PR before live creation.**

- Commercial AWS only; IAM is global. This creates no cluster, task, network, or application role.
- AWS owns this role's trust and permissions. It allows ECS to manage task networking, load-balancer registrations, discovery, scaling, and monitoring. It is shared across the account, not scoped to staging. [ECS role documentation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using-service-linked-roles-for-clusters.html)

| Bootstrap grant     | Scope                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Check absence       | `iam:GetRole` only; exact pathless `role/AWSServiceRoleForECS` ARN                            |
| Create              | `iam:CreateServiceLinkedRole`; exact account/role ARN; `iam:AWSServiceName=ecs.amazonaws.com` |
| Verify role         | Exact role: trust, path, attached policies, absence of inline policies                        |
| Inspect permissions | Only AWS-owned `AmazonECSServiceRolePolicy` and its versions                                  |

- No `PassRole`, general role/policy writes, tagging, deletion, or application-resource grants.
- The application Terraform root continues to require an existing role; it never creates or manages it.

## Prepare temporary access

Use Node.js 22 and a fresh [non-root temporary login](AWS-DISCOVERY.md). Keep credentials out of files.

```sh
umask 077
mkdir -p .wallie/aws
export AWS_PROFILE=wallie-staging
WALLIE_AWS_ACCOUNT_ID='<your-12-digit-account-id>'
node scripts/prepare-aws-ecs-service-role.mjs policy --account-id "$WALLIE_AWS_ACCOUNT_ID" > .wallie/aws/ecs-service-role-bootstrap-policy.json
```

- Rendering is offline. In IAM, create customer-managed **WallieStagingEcsServiceRoleBootstrap** from this file and attach it to `wallie-local`.
- This permission is temporary. It permits the [service-linked-role API](https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateServiceLinkedRole.html), which creates the service-defined role and permissions; do not create an ordinary IAM role or attach policies manually.

## Check, then create once

```sh
aws sts get-caller-identity
aws iam get-role --role-name AWSServiceRoleForECS
```

- Require the intended account and `wallie-local` non-root identity from the fresh session.
- [GetRole accepts a role name, without a path](https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRole.html). During our missing-role preflight, AWS evaluated `arn:aws:iam::<account>:role/AWSServiceRoleForECS`; the service-path grant returned `AccessDenied`. The temporary policy adds only `GetRole` at that exact pathless ARN. Creation and existing-role inspection keep the service-role path.
- Create only after an explicit **`NoSuchEntity`** response from `GetRole`. Access denial, expiry, or network failure does not establish absence.
- If the role already exists, require the service-role ARN/path and all checks below. A role at the pathless ARN is not an acceptable ECS prerequisite; do not recreate, import, retag, or edit it.
- Recheck identity and absence immediately before the single creation request:

```sh
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com
```

- Use no custom suffix. On timeout or an ambiguous result, inspect the role before retrying; do not assume creation failed.
- Live creation remains unqualified until this post-merge check. If AWS denies creation, stop and review the reported action; do not broaden IAM permissions automatically.

## Verify before removing access

```sh
aws iam get-role --role-name AWSServiceRoleForECS
aws iam list-attached-role-policies --role-name AWSServiceRoleForECS
aws iam list-role-policies --role-name AWSServiceRoleForECS
WALLIE_ECS_POLICY_ARN='arn:aws:iam::aws:policy/aws-service-role/AmazonECSServiceRolePolicy'
aws iam get-policy --policy-arn "$WALLIE_ECS_POLICY_ARN"
```

| Check                      | Required result                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Name / ARN                 | `AWSServiceRoleForECS` / `arn:aws:iam::<account>:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS` |
| Path                       | `/aws-service-role/ecs.amazonaws.com/`                                                                         |
| Trust                      | Only `ecs.amazonaws.com` may call `sts:AssumeRole`; no other principals or permissions                         |
| Boundary / inline policies | No permissions boundary; empty `PolicyNames`                                                                   |
| Attached policy            | Exactly `arn:aws:iam::aws:policy/aws-service-role/AmazonECSServiceRolePolicy`                                  |

Inspect the returned `DefaultVersionId` and its document; AWS can update this managed policy. Compare it with the [official policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonECSServiceRolePolicy.html).

```sh
WALLIE_ECS_POLICY_VERSION='<DefaultVersionId from get-policy>'
aws iam get-policy-version --policy-arn "$WALLIE_ECS_POLICY_ARN" --version-id "$WALLIE_ECS_POLICY_VERSION"
```

- Wait for IAM propagation and repeat reads if needed. Stop on mismatched identity, trust, path, or permissions; do not repair the service-owned role automatically.
- After verification, detach **WallieStagingEcsServiceRoleBootstrap** from `wallie-local` in IAM. Keep **WallieStagingApplication**, whose existing `GetRole` permission supports Terraform's prerequisite check.
- Confirm `GetRole` still succeeds, then resume the application foundation's absence checks and saved-plan review. Expected application plan remains **3 additions / 0 changes / 0 deletions**.
