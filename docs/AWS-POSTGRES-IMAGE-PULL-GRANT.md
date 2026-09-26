# Temporary PostgreSQL image-pull network grant

**Render one expiring IAM policy for the [default-off private image path](AWS-POSTGRES-IMAGE-PULL.md).** The renderer makes no AWS calls. This grant does not apply Terraform, mirror an image, create a host, or start PostgreSQL.

| Scope              | Limit                                                                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New resources      | A group with reviewed `Name` and `Component=postgres-image-pull` request tags in the exact VPC; rule authorization on that group and the exact database group. Creation-time tags and revocation of the new group's default egress. The plan must enforce one group and exactly three named TCP/443 rules. |
| Existing resources | `ModifyVpcEndpoint` on the exact ECR API, ECR DKR, and ECR layer S3 gateway endpoint IDs, the new PostgreSQL endpoint group, and the exact `database-a` route table. No unchanged shared group, service subnet, or service route-table permissions; no endpoint creation.                                  |
| Time and account   | Every statement is limited to the reviewed account, commercial region, and a UTC expiry 2–24 hours after rendering.                                                                                                                                                                                        |
| Excluded           | No IAM, ECR registry, S3 object, EC2 host, secret, default route, NAT, deletion, or permission to edit unrelated security groups.                                                                                                                                                                          |

The rendered `WallieStagingPostgresImagePullNetwork` managed policy must fit IAM's 6,144-character limit.

**IAM cannot constrain** the number or actual name of new groups, new rule names/tags or port/protocol/peer tuples, or the contents of `ModifyVpcEndpoint` requests to only the intended policy, security-group, or route-table changes. SG-resource authorization can permit untagged rules when a request omits rule TagSpecifications. The exact saved plan and live readback must enforce one group, three named/tagged rules, and the intended endpoint changes. The standing `WallieStagingPrivateConnectivity` policy may independently permit endpoint edits; permissions from multiple attached policies are additive.

## Prepare offline

1. Complete the separate [base Supabase network gate](AWS-SUPABASE-NETWORK-GRANT.md) first. Its grant creates the three groups/four rules but excludes this extension. The [host foundation grant](AWS-POSTGRES-DEPLOYMENT-GRANT.md), customer-managed EBS key, and rendered host boundary are separate prerequisites. Confirm the owned VPC, exact database group, `database-a` route table, and all three existing endpoints from fresh AWS inventory; stop if names, tags, IDs, or state differ. The [mirror receipt](AWS-POSTGRES-IMAGE-MIRROR.md) is required before a later pull probe, not to render this policy.
2. Choose a UTC deadline 2–24 hours ahead. Render the exact-resource policy and inspect every statement. Keep generated JSON under ignored `.wallie/aws/` with owner-only permissions:

   ```sh
   umask 077
   mkdir -p .wallie/aws
   node scripts/prepare-aws-postgres-image-pull-grant.mjs \
     --account-id '<reviewed-12-digit-account>' --region us-west-2 \
     --vpc-id '<reviewed-vpc-id>' \
     --database-security-group-id '<reviewed-database-sg-id>' \
     --database-route-table-id '<reviewed-database-a-route-table-id>' \
     --ecr-api-endpoint-id '<reviewed-ecr-api-endpoint-id>' \
     --ecr-dkr-endpoint-id '<reviewed-ecr-dkr-endpoint-id>' \
     --image-layers-endpoint-id '<reviewed-ecr-layer-s3-endpoint-id>' \
     --expires-at '<YYYY-MM-DDTHH:MM:SSZ>' \
     > .wallie/aws/postgres-image-pull-network-policy.json
   ```

3. An administrator creates customer-managed `WallieStagingPostgresImagePullNetwork` **unattached** from the reviewed JSON. Compare it with the [policy template](../infra/aws/postgres-image-pull-grant-policy.template.json); read back its default version, document, expiry, and every attached identity. Stop if it is attached unexpectedly or exceeds IAM's 6,144-character policy limit. If it expires before the attachment window, re-render and review a new default version while unattached.

## Temporary attachment and later apply

`wallie-local` already has **10/10** managed-policy attachments. Do not append this grant to the standing private-connectivity policy or attempt an eleventh attachment.

1. Record all ten attached policy ARNs/default versions. Confirm the exact `WallieStagingRegistry` ARN, default document, and every attached identity; stop if registry provisioning or image mirroring is active. An administrator detaches **only that Registry attachment from `wallie-local`** and attaches this expiring grant. Verify exactly ten attachments with the intended one-for-one difference. On failure, detach the new grant, restore the recorded Registry ARN, verify the original set, and stop.
2. Only after the base network and host are separately applied and verified, produce an **untargeted saved plan** for `infra/aws/staging-network` with `enable_postgres_image_pull=true` and both prerequisite flags still true. Require one new named group, exactly three named TCP/443 rules, no default egress, in-place ECR API/DKR endpoint policy and SG updates, and only the `database-a` route-table addition to the existing S3 gateway. Require no new endpoint, unrelated policy/repository, CIDR or default route, NAT, replacement, or deletion. Confirm at least 90 minutes of grant lifetime before applying the reviewed plan.
3. After an approved apply, enumerate the new and database groups' **complete** rule sets, including unmodeled extras. Read back exact ECR endpoint policies and SG attachments, the S3 gateway policy and `database-a` route, and the `postgres_image_pull` output IDs. Require a zero-diff full plan. The later digest-pinned pull probe needs the verified image mirror and host; this network readback alone does not prove a pull.
4. An administrator detaches the temporary grant, reattaches the **exact recorded** Registry ARN, and verifies all ten original attachments and default versions. Leave the temporary policy unattached; delete it after no further image-path apply is planned.

If expiry or apply failure interrupts the operation, inventory state and every partially changed endpoint, route, group, and rule before a new plan. AWS gives a new group default allow-all egress until Terraform revokes it; do not attach it to an endpoint while that egress remains. Never blindly retry or extend an attached grant. This PR performs no AWS changes.
