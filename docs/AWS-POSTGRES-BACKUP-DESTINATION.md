# AWS staging PostgreSQL backup destination

**Prepare an empty S3 bucket outside the PostgreSQL host state with a reviewed default retention period.** Uploads remain denied until writer access, a private network path, and recovery testing are reviewed.

```mermaid
flowchart LR
    tf["Backup Terraform root"] --> state[("staging/backup.tfstate")]
    tf --> bucket[("Private S3 bucket · empty")]
    db["Future PostgreSQL backup writer"] -. "blocked" .-> bucket
    bucket -. "future isolated restore" .-> restore["Recovery rehearsal"]
```

| Control   | Configuration                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| Name      | `wallie-staging-postgres-backups-<account-id>-<region>`                                                            |
| State     | Separate `staging/backup.tfstate` and `.tflock` in the existing state bucket                                       |
| Ownership | Bucket owner enforced; ACLs disabled                                                                               |
| Access    | All four S3 public-access blocks; deny non-TLS access; deny every object upload                                    |
| Data      | Versioning and Object Lock enabled; reviewed 1–365 day GOVERNANCE default for new versions; default SSE-S3 AES-256 |
| Deletion  | `prevent_destroy` and `force_destroy = false` on the bucket                                                        |

- [Object Lock requires versioning and cannot later be disabled](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html). The required `backup_retention_days` input has no default; choose and review a whole number from 1 to 365 before the live plan. A bucket default applies only to new object versions. The upload deny remains the gate; this bucket does not yet contain protected backups.
- Terraform `prevent_destroy` applies while the resource stays in configuration; it cannot protect a removed block or lost state. [Terraform lifecycle reference](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle).
- The [existing database subnet S3 endpoint](AWS-POSTGRES-IMAGE-PULL.md) permits ECR image layers only. The host has no backup S3 writer grant or upload route.

## Offline review

Use Terraform **1.16.3** and AWS provider **6.65.0**. The test provider is mocked and makes no AWS changes.

```sh
terraform -chdir=infra/aws/staging-backup fmt -check
terraform -chdir=infra/aws/staging-backup init -backend=false -lockfile=readonly
terraform -chdir=infra/aws/staging-backup validate
terraform -chdir=infra/aws/staging-backup test
node scripts/prepare-aws-state.mjs backend --component backup --account-id <account-id> --region us-west-2
```

## Live deployment gate

1. Reauthenticate as a non-root staging operator and verify the account and region. Inspect the intended bucket name; an access error is not proof of absence. If it exists, require the six existing resources in this root's state, inspect the live controls and Object Lock rule, and verify that it has no object versions. Stop if ownership or contents are uncertain.
2. Have an administrator compare the live `WallieStagingStateAccess` default document with the [merged template](../infra/aws/state-access-policy.template.json). Add only `staging/backup.tfstate` and its lock to the existing policy, preserving its old default version for rollback. The `wallie-local` identity already has 10/10 managed-policy attachments.
3. Follow the [temporary bucket deployment grant](AWS-POSTGRES-BACKUP-DEPLOYMENT-GRANT.md) before a live plan or apply. Require an additions-only plan for the bucket and six controls if absent, or only the retention configuration if the six earlier resources are already managed and verified. Read back versioning, Object Lock mode and days, encryption, ownership, public-access blocks, and both policy denies.

## Before the first backup

| Next control | Required proof                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retention    | Verify the deployed GOVERNANCE duration against the reviewed input. Keep the upload deny until writer access and recovery are ready; retain the TLS deny. Routine writers must lack bypass, retention-change, and delete permissions. |
| Writer path  | Scope writes to a backup prefix and this bucket; extend the private S3 endpoint policy for the database subnet without widening ECR layer access.                                                                                     |
| PostgreSQL   | Take a valid base backup and archive a complete WAL chain for point-in-time recovery. Verify the manifest and complete an isolated timed restore.                                                                                     |
| Other data   | Preserve `pgsodium_root.key` separately from database files; back up Supabase Storage objects separately from metadata.                                                                                                               |
| Operations   | Define retention cleanup, alerting, restore ownership, and a recovery target before production data moves.                                                                                                                            |

The bucket alone is not a backup. [PostgreSQL recovery](https://www.postgresql.org/docs/17/continuous-archiving.html), [Supabase key warning](https://supabase.com/docs/guides/self-hosting/postgres-upgrade-17), [Supabase self-hosting responsibilities](https://supabase.com/docs/guides/self-hosting).
