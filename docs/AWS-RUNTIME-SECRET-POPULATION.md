# Populate staging runtime secrets

**Write the first real web and worker versions only for an isolated self-hosted staging Supabase database.** Run this locally after reviewing and merging the helper. It does not create a database, grant IAM access, or start tasks.

| Gate         | Requirement                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database     | Fresh schema-only self-hosted Supabase stack in this AWS account; apply migrations without seeds or copied rows. Require no active integrations or runnable Wallie jobs. Never point the worker at the current Wallie database. |
| Inputs       | This stack's generated `sb_secret_…` key and one **new** 64-character random hex `WALLIE_ENCRYPTION_KEY`, kept in a password manager. Do not reuse the production encryption key.                                               |
| AWS          | Account `111614490109`, region `us-west-2`, non-root `wallie-local`, both exact owned runtime secrets still empty **including deprecated versions**.                                                                            |
| Write access | A separately reviewed, temporary `secretsmanager:PutSecretValue` grant on only the two full secret ARNs. `wallie-local` currently lacks this action. Revoke the grant after both versions are verified.                         |

- Use the [temporary write-grant procedure](AWS-RUNTIME-SECRET-WRITE-GRANT.md) on the existing `WallieStagingRuntimeSecrets` managed policy. Check every attached identity and preserve the original default version for rollback; `wallie-local` already occupies all ten managed-policy attachment slots. This helper never changes IAM.
- Each ECS execution role already has `GetSecretValue` only on its own component ARN. The operator needs no `GetSecretValue`; the helper never calls it.
- The helper pins this account, region, and the two full secret ARNs in code. The only command inputs are non-secret version IDs; it rejects a legacy Supabase service-role key.
- Do not put values in `.env`, command arguments, shell history, PRs, chat, CloudShell paste, or files. Run this in your own local terminal; the helper requires a TTY and hides input. It rejects enabled AWS CLI history, which can store API request data. [AWS CLI history](https://docs.aws.amazon.com/cli/latest/userguide/data-protection.html)
- AWS child processes use only the `wallie-staging` login context; ambient endpoint overrides and proxies are removed, and configured custom endpoints are ignored. [AWS CLI endpoint settings](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-envvars.html)
- Keep app tasks stopped and serialize writes. Metadata checks narrow the race window but are not atomic with `PutSecretValue`.

## Run once

Generate **non-secret** version IDs and keep them until both writes are verified:

```sh
WEB_VERSION_ID="$(openssl rand -hex 16)"
WORKER_VERSION_ID="$(openssl rand -hex 16)"

AWS_PROFILE=wallie-staging node scripts/populate-aws-runtime-secrets.mjs \
  --web-version-id "$WEB_VERSION_ID" --worker-version-id "$WORKER_VERSION_ID"
```

- At the hidden prompts, paste the self-hosted stack's secret key and the **same fresh staging encryption key** twice. The script does not read app values from the environment or disk. The [self-hosted key generator](https://supabase.com/docs/guides/self-hosting/docker#generate-keys-and-secrets) creates the `sb_secret_` key; no Supabase Cloud organization is involved.
- It checks account/identity, exact ARN/name/tags, default encryption, no resource policy, and zero versions before either write. It rechecks each secret immediately before writing.
- It sends only `SecretString` through the AWS CLI's stdin (`file:///dev/stdin`); ARN, version token, and `AWSCURRENT` are non-secret arguments. [AWS CLI file parameters](https://docs.aws.amazon.com/cli/latest/userguide/cli-usage-parameters-file.html)
- Success prints only each component ARN, version ID, and `version-metadata-matched`. It requires one exact `AWSCURRENT` version per secret. AWS uses `ClientRequestToken` as `VersionId`; secret values are omitted from CloudTrail request logs. [PutSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html)

## If interrupted

- **Do not rerun the command or generate new IDs.** The two writes are not atomic, and a failed response may follow a successful write. Inspect both secrets with `describe-secret` and `list-secret-version-ids --include-deprecated`; never call `GetSecretValue` for this check.
- If one version exists or labels differ, stop for a reviewed recovery using the saved version IDs and staging key from your password manager. The helper refuses to overwrite any existing version.
- After both versions match, revoke the temporary write grant. Feed the two IDs into [the runtime configuration map](AWS-RUNTIME-CONFIG.md) and later real task definitions; those must pin their own component version. The worker stays stopped until the isolated database and private HTTPS route are verified.
