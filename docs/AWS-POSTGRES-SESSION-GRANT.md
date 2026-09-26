# Temporary PostgreSQL session-logging deployment grants

**Render two expiring IAM policies for the [default-off transcript path](AWS-POSTGRES-SESSION-LOGGING.md).** The renderer makes no AWS calls. These grants do not enable the Terraform flags, change regional Session Manager preferences, or authorize an operator shell.

| Policy                                | Apply scope                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WallieStagingPostgresSessionNetwork` | One named Logs endpoint group in the reviewed VPC, two tagged rules involving the exact database group, and an in-place policy/group update on the exact existing Logs endpoint. |
| `WallieStagingPostgresSessionHost`    | One named CloudWatch log group and 90-day retention, plus an inline policy on the exact bounded host role.                                                                       |

Every statement expires at the same required UTC deadline 2–24 hours after rendering. The network grant cannot create or edit other endpoints or routes; the host grant cannot grant `StartSession`, change the role boundary, or delete the log group. IAM cannot restrict the number of new groups or rules, their actual port/peer tuples, the contents of `ModifyVpcEndpoint` or `PutRolePolicy`, the retention day count, or whether deletion protection is enabled in `CreateLogGroup`. EC2 rule authorization can also permit an untagged rule if a request omits rule tags. Enforce these values with saved plans, the existing host boundary, and complete live rule readback. Other attached policies are additive.

## Prepare offline

1. Apply and verify the [base Supabase network](AWS-SUPABASE-NETWORK-GRANT.md) and [private host foundation](AWS-POSTGRES-DEPLOYMENT-GRANT.md) first. Confirm the exact staging account, VPC, database security group, existing Logs endpoint ID/tags/policy/group attachments, host role/inline policies/boundary, and that neither new session-logging group exists. Stop on drift or missing read permissions.
2. Read the deployed default `WallieStagingPostgresHostBoundary` policy. It must match the [merged template](../infra/aws/postgres-host-boundary-policy.template.json), including the exact session log group and stream actions. If the live default lacks those actions, an administrator must review, create, select, and read back a new version **before** the host apply. Preserve the previous default for rollback; stop if the five-version limit prevents that. Neither temporary grant can edit this boundary.
3. Choose a UTC deadline 2–24 hours ahead. Render each policy under ignored `.wallie/aws/` with owner-only permissions. Review the two documents and their expiry:

   ```sh
   umask 077
   mkdir -p .wallie/aws
   node scripts/prepare-aws-postgres-session-grant.mjs \
     --policy network --account-id 111614490109 --region us-west-2 \
     --vpc-id '<reviewed-vpc-id>' \
     --database-security-group-id '<reviewed-database-sg-id>' \
     --logs-endpoint-id '<reviewed-logs-endpoint-id>' \
     --expires-at '<YYYY-MM-DDTHH:MM:SSZ>' \
     > .wallie/aws/postgres-session-network-policy.json
   node scripts/prepare-aws-postgres-session-grant.mjs \
     --policy host --account-id 111614490109 --region us-west-2 \
     --expires-at '<same-UTC-deadline>' \
     > .wallie/aws/postgres-session-host-policy.json
   ```

4. An administrator creates both customer-managed policies **unattached**. Read back each default document, expiry, and attached identities. Stop if either is attached unexpectedly. Re-render and review a fresh version while unattached if the deadline is too near.

## Temporary attachment and apply

`wallie-local` has 10/10 managed-policy attachments. Use a **sequential one-for-one swap** with the exact `WallieStagingRegistry` attachment; do not attach both session grants together. Record all ten original ARNs/default versions and every identity attached to the Registry policy. Stop if registry work or image mirroring is active or inventory differs.

1. Detach only Registry from `wallie-local`; attach the network grant; verify the one intended difference and ten total attachments. Preserve every existing value in `network.tfvars.json`, including `enable_private_connectivity=true` and `enable_self_hosted_supabase_connectivity=true`, and set `enable_postgres_session_logging=true`. Save a **full, untargeted** `staging-network` plan. Require one named group, two named SG-referenced TCP/443 rules, and only the existing Logs endpoint policy/group update; no replacement/deletion, ECR/S3 edit, route, public ingress, or broad CIDR. Require at least 90 minutes of grant lifetime before applying only the reviewed saved plan. Read back the complete group rules, Logs endpoint policy and group attachments, and a zero-diff plan. Restore the exact Registry attachment and verify all ten originals before the next swap.
2. Verify the reviewed host boundary is live. Swap Registry for the host grant, then save a **full, untargeted** `staging-postgres` plan with the exact original host inputs and `enable_postgres_session_logging=true`. Require only the named 90-day `STANDARD`, deletion-protected log group and the scoped `wallie-staging-postgres-session-logs` role policy. No host, volume, endpoint, or database runtime replacement. With at least 90 minutes left, apply only the saved plan; read back log group class, retention, deletion protection, tags, inline policy, role boundary, and a zero-diff plan. Restore the exact Registry attachment and verify the ten original attachments/default versions.
3. Leave both temporary policies unattached; delete them after no further apply is planned. If any swap or apply fails, remove the new attachment, restore Registry, inspect live resources and Terraform state, and review a fresh plan before retrying. Do not blindly extend or retry an expired grant.

The account-wide Session Manager logging preferences and exact-instance operator `StartSession` grant remain separate gates. Verify the private transcript stream with a no-secrets shell and CloudTrail start/end events before database administration. [Session logging activation](AWS-POSTGRES-SESSION-LOGGING.md)

The pinned AWS provider sends log-group tags in `CreateLogGroup` and configures 90-day retention with `PutRetentionPolicy`; it sets deletion protection in the create request. [Provider source](https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v6.65.0/internal/service/logs/group.go), [CloudWatch Logs IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_logs.html), [EC2 IAM actions](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html)
