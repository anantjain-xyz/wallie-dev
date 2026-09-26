# Temporary PostgreSQL backup destination grant

**Permit one reviewed apply of the empty staging backup bucket.** The renderer makes no AWS calls. Its 2–24 hour policy grants bucket configuration and readback on one exact name to `wallie-local`; it grants no object writes, replication, bucket deletion, or IAM changes.

| Boundary      | Requirement                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Bucket        | `wallie-staging-postgres-backups-<account-id>-<region>` only                                                   |
| Region        | `s3:LocationConstraint` on `CreateBucket`; do not use `us-east-1` with this renderer                           |
| Identity      | Exact `wallie-local` user ARN and principal account                                                            |
| Creation      | Tagged `CreateBucket`, versioning, and Object Lock dependent permissions                                       |
| Configuration | Encryption, owner controls, public-access blocks, reviewed Object Lock default, and the two-deny bucket policy |
| Lifetime      | Every statement ends at the required UTC deadline                                                              |

The grant can change configuration values on this exact bucket while attached. IAM cannot inspect a proposed bucket policy or public-access-block payload. The **saved plan and live readback** must enforce the values in the [bucket root](../infra/aws/staging-backup/main.tf). AWS requires [`TagResource` for tagged bucket creation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-create-tag.html) and [versioning plus Object Lock permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html) at creation.

## Prepare

1. Use a fresh non-root `wallie-staging` login. Verify STS returns account `111614490109`, region `us-west-2`, and user `wallie-local`. Check the exact planned bucket with `head-bucket`; **404** means absent, while **403** is inconclusive. If it exists, require that the six existing resources are managed by this backup root, inspect all live controls and the Object Lock rule, and require an empty object-version listing. Stop if ownership, state, or contents are uncertain. Record the current state bucket and Terraform state keys.
2. An administrator compares the live `WallieStagingStateAccess` default policy with the [merged template](../infra/aws/state-access-policy.template.json), then adds only `staging/backup.tfstate` and its `.tflock` resource. Preserve the former default version; stop at the five-version limit if it cannot be preserved. Read back the new default and every attached identity. The merged template alone did not update IAM.
3. Choose and review a whole-number `backup_retention_days` from 1 to 365, then pick a UTC deadline 2–24 hours ahead. Render the deployment policy locally under ignored `.wallie/aws/`. Inspect its exact bucket ARN, actions, conditions, and expiry. The grant already includes the Object Lock configuration calls; a reviewed default rule does not require object-write access.

   ```sh
   umask 077
   mkdir -p .wallie/aws
   export AWS_PROFILE=wallie-staging
   export AWS_REGION=us-west-2
   WALLIE_AWS_ACCOUNT_ID=111614490109
   WALLIE_BACKUP_RETENTION_DAYS='<reviewed whole number from 1 to 365>'
   node scripts/prepare-aws-backup-deployment.mjs \
     --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" \
     --expires-at '<YYYY-MM-DDTHH:MM:SSZ>' \
     > .wallie/aws/backup-deployment-policy.json
   node scripts/prepare-aws-state.mjs backend --component backup \
     --account-id "$WALLIE_AWS_ACCOUNT_ID" --region "$AWS_REGION" \
     > .wallie/aws/backup.backend.hcl
   aws sts get-caller-identity
   aws s3api head-bucket --bucket "wallie-staging-postgres-backups-$WALLIE_AWS_ACCOUNT_ID-$AWS_REGION"
   ```

4. The administrator creates **unattached** customer-managed `WallieStagingPostgresBackupDestination` from the rendered JSON. Read back the document, expiry, and attached identities. Stop if any identity is attached.

## One-for-one attachment and apply

`wallie-local` was last documented at **10/10** managed-policy attachments; verify the live count. Do not attempt an eleventh attachment or change the state-access attachment.

1. The administrator records all current attachment ARNs and default versions. Confirm `WallieStagingRegistry` is attached only to `wallie-local` and no registry provisioning is in progress. Detach only that policy from `wallie-local`, attach `WallieStagingPostgresBackupDestination`, and read back exactly the intended one-for-one difference. If any step fails, restore the exact Registry ARN and stop.
2. Initialize the separate backend and save a **full, untargeted** plan. For an absent bucket, require **seven additions, zero changes, zero deletions**: the bucket, versioning, Object Lock default retention, SSE-S3, owner enforcement, public-access block, and bucket policy. If all six earlier resources are already managed and verified, require **one addition, zero changes, zero deletions** for the retention configuration. Verify the exact name/account/region, `force_destroy = false`, GOVERNANCE mode and the reviewed days, and both `DenyInsecureTransport` and `DenyUploadsUntilRecoveryControls` statements. Reject any object, lifecycle expiration, IAM, route, or compute resource. Require at least 90 minutes of grant lifetime before apply.

   ```sh
   WALLIE_AWS_FILES="$PWD/.wallie/aws"
   terraform -chdir=infra/aws/staging-backup init -lockfile=readonly \
     -backend-config="$WALLIE_AWS_FILES/backup.backend.hcl"
   terraform -chdir=infra/aws/staging-backup plan \
     -var="aws_account_id=$WALLIE_AWS_ACCOUNT_ID" -var="aws_region=$AWS_REGION" \
     -var="backup_retention_days=$WALLIE_BACKUP_RETENTION_DAYS" \
     -out="$WALLIE_AWS_FILES/backup.tfplan"
   terraform -chdir=infra/aws/staging-backup show "$WALLIE_AWS_FILES/backup.tfplan"
   terraform -chdir=infra/aws/staging-backup apply "$WALLIE_AWS_FILES/backup.tfplan"
   ```

3. Read back the exact bucket's region, versioning, Object Lock capability and **GOVERNANCE default with exactly the reviewed days**, SSE-S3, bucket-owner enforcement, all four public-access blocks, six tags, and both bucket-policy denies. List object versions and require none. Do **not** test with an upload. Run a full plan and require exit code 0:

   ```sh
   WALLIE_BACKUP_BUCKET="wallie-staging-postgres-backups-$WALLIE_AWS_ACCOUNT_ID-$AWS_REGION"
   aws s3api get-bucket-location --bucket "$WALLIE_BACKUP_BUCKET"
   aws s3api get-bucket-versioning --bucket "$WALLIE_BACKUP_BUCKET"
   aws s3api get-object-lock-configuration --bucket "$WALLIE_BACKUP_BUCKET"
   aws s3api get-bucket-encryption --bucket "$WALLIE_BACKUP_BUCKET"
   aws s3api get-bucket-ownership-controls --bucket "$WALLIE_BACKUP_BUCKET"
   aws s3api get-public-access-block --bucket "$WALLIE_BACKUP_BUCKET"
   aws s3api get-bucket-tagging --bucket "$WALLIE_BACKUP_BUCKET"
   aws s3api get-bucket-policy --bucket "$WALLIE_BACKUP_BUCKET"
   aws s3api list-object-versions --bucket "$WALLIE_BACKUP_BUCKET"
   terraform -chdir=infra/aws/staging-backup plan \
     -var="aws_account_id=$WALLIE_AWS_ACCOUNT_ID" -var="aws_region=$AWS_REGION" \
     -var="backup_retention_days=$WALLIE_BACKUP_RETENTION_DAYS" \
     -detailed-exitcode
   ```

4. The administrator detaches the temporary grant, reattaches the exact recorded `WallieStagingRegistry` ARN, and verifies the original attachment set and default versions. Leave the temporary policy unattached; delete it when no further bucket apply is planned.

If the grant expires or an apply fails, inspect the bucket, every control, Terraform state, and the full plan before a separately reviewed retry. The provider may create a bucket **before the upload-deny policy exists**. Stop all backup work, verify the live policy and object versions, and treat a missing deny or unexpected object as an unprotected-data incident for administrator containment. Never delete an unexpected bucket or widen the grant merely to complete an apply. [Writer access, private S3 routing, and recovery proof](AWS-POSTGRES-BACKUP-DESTINATION.md#before-the-first-backup) remain separate.
