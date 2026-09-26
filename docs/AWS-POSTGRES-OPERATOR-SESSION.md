# Temporary PostgreSQL operator shell

**Grant `wallie-local` a short-lived shell on one verified staging PostgreSQL instance.** The renderer is offline; it does not attach a policy, start a session, change regional preferences, or start PostgreSQL.

| Permission                    | Boundary                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ssm:StartSession`            | Exact EC2 instance and account-owned `SSM-SessionManagerRunShell` document in the reviewed region. No SSH or port-forwarding document.                                                                      |
| `ssmmessages:OpenDataChannel` | Exact `wallie-local` principal, account, region, and expiry. AWS's service authorization reference lists no resource ARN for this action, so it uses `Resource: "*"`; the start action remains host-scoped. |
| `ssm:TerminateSession`        | Only `wallie-local` sessions on the reviewed instance, checked by the user-name session ARN and AWS's target-ID system tag.                                                                                 |

Every statement expires at the same UTC deadline 2–24 hours after rendering. Expiry blocks new authorized calls; it does **not** forcibly end an open shell. The grant has no `SendCommand`, `ResumeSession`, KMS, log-reading, document-editing, or IAM permissions. Other attached policies remain additive; inventory their effective session privileges before claiming this identity can access only this host. [AWS's Session Manager policy example](https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-restrict-access-quickstart.html), [own-session termination guidance](https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-restrict-access-examples.html), [message gateway authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ssmmessages.html), and [principal ARN condition key](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html) define these bounds.

## Before rendering

1. Apply and verify the [base Supabase network](AWS-SUPABASE-NETWORK.md), [private host foundation](AWS-POSTGRES-HOST.md), and [private transcript path](AWS-POSTGRES-SESSION-LOGGING.md). Read the **live** `staging-postgres` Terraform `host.instance_id`; do not invent or reuse an earlier instance ID. Confirm its account, `database-a` subnet, private address, expected instance profile and role boundary, SSM online state, and no public address.
2. An administrator inspects the account-wide regional `SSM-SessionManagerRunShell` preferences, including maximum session duration, and other managed nodes that use them. Require CloudWatch streaming to exactly `/wallie/staging/postgres/session`, `cloudWatchStreamingEnabled=true`, and `cloudWatchEncryptionEnabled=false` for the existing default-encrypted group. Stop if current preferences differ; changing them is a separate review because it can affect other nodes. Confirm the private Logs endpoint/group path and 90-day, deletion-protected log group are live. If session-data KMS encryption is enabled, stop until its key and private permissions are separately reviewed.
3. Renew the non-root `wallie-staging` login and verify `aws sts get-caller-identity` is `arn:aws:iam::<account-id>:user/wallie-local`. Use AWS CLI v2. Install the [AWS Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) on the operator machine and check `session-manager-plugin --version` is at least **1.2.764.0** before the probe. Select an expiry 2–24 hours ahead.

```sh
umask 077
mkdir -p .wallie/aws
export AWS_PROFILE=wallie-staging
export AWS_REGION=us-west-2
aws sts get-caller-identity
terraform -chdir=infra/aws/staging-postgres output -json host
node scripts/prepare-aws-postgres-session-operator.mjs \
  --account-id '<reviewed-12-digit-account>' --region us-west-2 \
  --instance-id '<live-host.instance_id>' \
  --expires-at '<YYYY-MM-DDTHH:MM:SSZ>' \
  > .wallie/aws/postgres-session-operator-policy.json
```

Review all rendered actions, resources, conditions, expiry, and the exact instance ID. An administrator creates `WallieStagingPostgresOperator` unattached, then reads back its default version, document, expiry, and attached identities. Stop if an existing policy with that name differs or is attached unexpectedly.

## Temporary attachment and no-secrets proof

`wallie-local` already has **10/10 managed policies**. Record the exact ten ARN/version pairs, inspect their effective `StartSession`, `SendCommand`, and `ssmmessages` permissions, and record every identity attached to `WallieStagingRegistry`; stop if registry or image work is active. The administrator detaches only Registry from `wallie-local`, attaches this operator policy, and verifies exactly one substitution and ten total attachments. If attachment fails, restore Registry immediately. Do not overlap this swap with another temporary grant.

1. Require at least 90 minutes before expiry. Start a default shell with `aws --profile wallie-staging --region us-west-2 ssm start-session --target '<reviewed-instance-id>' --document-name SSM-SessionManagerRunShell --reason 'Wallie PostgreSQL no-secrets transcript probe'`. Record the printed session ID. Type only a fresh non-secret marker such as `printf 'wallie-postgres-session-probe-<nonce>\n'`, then `exit`. Do not enter database credentials, encryption keys, tokens, or customer data.
2. An administrator checks that exact session's state. If it remains active, terminate it with `aws ssm terminate-session --session-id '<recorded-session-id>'` using an authorized administrator identity. Verify it ended, then confirm CloudTrail's `StartSession` and `TerminateSession` events. Policy expiry alone does not close an open shell.
3. An administrator reads the exact CloudWatch log group and confirms a new stream contains the marker, with matching time and instance/session identity. Inspect the live regional preferences again. A successful connection without a transcript does **not** authorize database administration. The offline policy test cannot prove that AWS accepts the data-channel authorization; the live no-secrets session is required. Detach `WallieStagingPostgresOperator`, restore the exact Registry ARN, and verify all ten original attachments and versions. Leave the temporary policy unattached; delete it after no further use is planned. If the grant expires or a probe fails, an administrator must terminate any active probe and verify its ended state, restore Registry, then inspect session state and logs before a freshly reviewed retry.

The probe proves this host's private shell path and logging at that time. It does not prove image pull, durable PostgreSQL startup, database backups, or restore. Repeat the transcript check before later database administration if host, role, endpoint, logging preferences, or policy changes.
