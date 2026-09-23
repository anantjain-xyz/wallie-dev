# Temporary runtime-secret write grant

**Add `PutSecretValue` to the existing `WallieStagingRuntimeSecrets` policy only long enough to populate the two empty staging secrets.** This renderer makes no AWS calls and contains no values.

| Boundary  | Requirement                                                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator  | `wallie-local` in account `111614490109`; check all users, groups, and roles attached to the policy before changing its default version. Require only this user.                                                     |
| Resources | Exact existing web ARN ending `runtime-vDeDr4` and worker ARN ending `runtime-4C4k43` in `us-west-2`; no wildcard suffix.                                                                                            |
| Grant     | `secretsmanager:PutSecretValue` only, gated by account, region, and existing `WallieStack`, `Component`, and `Name` resource tags. No value read, version-label update, IAM, or KMS action.                          |
| Limit     | IAM cannot make this action “first version only” or inspect the payload. The [population helper](AWS-RUNTIME-SECRET-POPULATION.md) performs empty-version and metadata checks; revoke this grant promptly afterward. |

## Prepare and review

1. Confirm both full ARNs and ownership tags with `describe-secret`, and zero versions with `list-secret-version-ids --include-deprecated`. Keep app tasks stopped.
2. In **IAM → Policies → WallieStagingRuntimeSecrets**, record the current default version ID and save its JSON privately. Check **Attached entities**: exactly user `wallie-local`, no group or role. Stop if another identity uses the policy.
3. Render the current baseline and proposed version locally:

   ```sh
   umask 077
   mkdir -p .wallie/aws
   node scripts/prepare-aws-secrets.mjs --account-id 111614490109 --region us-west-2 > .wallie/aws/runtime-secrets-baseline.json
   node scripts/prepare-aws-runtime-secret-write-grant.mjs > .wallie/aws/runtime-secrets-temporary-write.json
   ```

4. Compare the saved **current default** JSON with `runtime-secrets-baseline.json` by policy semantics, ignoring whitespace and key order. Stop if it differs. Compare the proposed JSON: the only additions must be the two `TemporaryPut…RuntimeValue` statements on the full ARNs. The rendered policy is 5,410 non-whitespace characters, below IAM's 6,144-character managed-policy limit.

## Enable, then remove

1. In the same policy, choose **Edit → JSON** and paste `runtime-secrets-temporary-write.json`. Review the two added statements and save as the **new default version**. If IAM asks to discard a version at the five-version limit, preserve the original default version; stop if that is impossible. Confirm the new default and attached identities in readback.
2. Run the guarded [runtime-secret population](AWS-RUNTIME-SECRET-POPULATION.md) once from the local terminal. Save its two non-secret version IDs and verify each secret has exactly one `AWSCURRENT` version. Stop on any ambiguous result; do not grant broader access or retry blindly.
3. In **Policy versions**, set the recorded original version as default. Verify it no longer contains `PutSecretValue`, then delete the temporary write-enabled version. Recheck attached identities. Keep the original policy attached for creation and metadata access.

The default version affects **every attached identity**, and IAM stores at most five versions. Restoring the old default removes this grant; deleting the temporary version prevents accidental reactivation. [IAM versioning](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_managed-versioning.html), [Secrets Manager authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_secretsmanager.html)
