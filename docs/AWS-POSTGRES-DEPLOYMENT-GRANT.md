# Temporary PostgreSQL host deployment grant

**Render two expiring IAM policies for the private host foundation.** The renderer makes no AWS calls. It does not enable a database, an operator session, or a backup path.

| Policy           | Grant                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity/network | Named host role with the fixed five-action permissions boundary and matching inline SSM policy; `PassRole` only for that role. Reviewed VPC, `database-a` subnet, Supabase database group, SSM endpoint group/rules, and `ssm`/`ssmmessages` endpoints. |
| Compute/storage  | Exact Amazon-owned AL2023 AMI, one named EC2 host, separate encrypted 100 GiB gp3 data volume and attachment, reviewed customer-managed EBS KMS key.                                                                                                    |
| Both             | Every permission expires at the same required UTC deadline 2–24 hours after rendering. No operator `StartSession`, database runtime, secrets, backups, public routes, SSH, termination, or teardown.                                                    |

IAM conditions cannot prove the **number** of resources, exact security-group rule tuples, complete endpoint configuration, or absence of unmodeled resources. `ec2:KmsKeyId` applies to standalone `CreateVolume`, not the `RunInstances` root volume: Terraform pins both keys, while the saved plan and live readback must verify the root. The fixed [permissions boundary](../infra/aws/postgres-host-boundary-policy.json) caps the role even if an inline policy is changed during the grant.

## Prepare offline

1. Renew non-root `wallie-staging` login. Confirm the account, VPC, subnet, network-owned database group and its complete rules, exact AMI and SSM Agent version, existing instances/volumes/endpoints, IAM role/profile, and account quota. Select an enabled same-account, same-region customer-managed symmetric KMS key; verify its key policy permits the operator's EBS use actions. Prepare a key in a separate reviewed batch if none exists. Stop if any Terraform-managed PostgreSQL host resource already exists.
2. Update the live `WallieStagingStateAccess` policy to include `staging/postgres.tfstate` and its `.tflock` key. Compare its deployed default document with the [merged template](../infra/aws/state-access-policy.template.json); merely changing the template did not update AWS.
3. An administrator creates `WallieStagingPostgresHostBoundary` from the exact [five-action policy](../infra/aws/postgres-host-boundary-policy.json) **before** the host plan. Verify the default document and ARN `arn:aws:iam::<account-id>:policy/WallieStagingPostgresHostBoundary`. Keep it as the host role's permanent boundary; the temporary grant must not edit or remove it.
4. Render both grants with the same reviewed identifiers and UTC expiry. Save them only under ignored `.wallie/aws/`, then inspect every statement. An administrator creates unattached customer-managed `WallieStagingPostgresIdentityNetwork` and `WallieStagingPostgresComputeStorage` policies. Confirm each default document and that both have no attached identities.

   ```sh
   umask 077
   mkdir -p .wallie/aws
   node scripts/prepare-aws-postgres-deployment.mjs \
     --policy identity-network \
     --account-id 111614490109 --region us-west-2 \
     --vpc-id '<reviewed-vpc-id>' \
     --subnet-id '<reviewed-database-a-subnet-id>' \
     --database-security-group-id '<reviewed-supabase-db-group-id>' \
     --ami-id '<reviewed-al2023-ami-id>' \
     --kms-key-arn '<reviewed-customer-managed-ebs-key-arn>' \
     --expires-at '<YYYY-MM-DDTHH:MM:SSZ>' \
     > .wallie/aws/postgres-identity-network-policy.json
   node scripts/prepare-aws-postgres-deployment.mjs \
     --policy compute-storage \
     --account-id 111614490109 --region us-west-2 \
     --vpc-id '<reviewed-vpc-id>' \
     --subnet-id '<reviewed-database-a-subnet-id>' \
     --database-security-group-id '<reviewed-supabase-db-group-id>' \
     --ami-id '<reviewed-al2023-ami-id>' \
     --kms-key-arn '<reviewed-customer-managed-ebs-key-arn>' \
     --expires-at '<same-UTC-deadline>' \
     > .wallie/aws/postgres-compute-storage-policy.json
   ```

## Temporary attachment and apply

`wallie-local` already has 10/10 managed-policy attachments. This host apply needs a reviewed **two-for-two** swap; neither temporary policy is useful alone:

1. Record all ten attached policy ARNs and default version IDs. Confirm `WallieStagingRegistry` and `WallieStagingImageSigning` are both attached to `wallie-local`, with no registry provisioning or image signing in progress. Record each exact ARN, default document, and every attached identity. Stop if the live identity inventory differs from this reviewed state.
2. The administrator detaches only those two attachments from `wallie-local`, then attaches the two temporary PostgreSQL policies. Verify exactly ten attachments and only the two intended replacements. If any step fails, detach any newly attached PostgreSQL policy, restore both original exact ARNs, verify the original set, and stop. Keep network, private connectivity, hardening, state, and sign-in grants attached.
3. Complete the [network and HTTPS gate](AWS-SUPABASE-NETWORK.md) first. The database group must exist and be verified. Produce an **untargeted saved plan** for `infra/aws/staging-postgres` with the exact reviewed inputs. Inspect every create/update/delete and relevant attribute. Require only the resources in the table above, with no replacement or deletion, no public address, no extra rule, and no unexpected IAM or KMS access. Require at least 90 minutes of grant lifetime before apply.
4. Apply only the reviewed saved plan. Read back the instance, volumes, attachment, actual EBS KMS key, all security-group rules, endpoints and private DNS, instance role/profile and boundary, and SSM registration. Require a zero-diff full plan. The data volume stays unformatted; do not start a database.
5. The administrator detaches both temporary PostgreSQL policies, reattaches the exact recorded `WallieStagingRegistry` and `WallieStagingImageSigning` ARNs, and verifies all ten original attachments and versions. Leave the temporary policies unattached, then delete them when no further host apply is planned.

If the grant expires or an apply fails, inspect Terraform state and all partially created resources before any new plan. Do not blindly retry. Each live resource incurs AWS charges. A future operator session needs an exact-instance grant and a private transcript destination before database administration.
