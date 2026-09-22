# AWS runtime configuration contract

**Prepare the minimum web/worker variable map without writing values or registering tasks.** Use before populating the real runtime secrets for an isolated staging database.

| Category              | Existing variables                                                                        | Source                                          |
| --------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Browser-visible       | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Deployment settings for each installation       |
| Plain setting         | `WALLIE_DEPLOY_ENV`                                                                       | Select its value with the service configuration |
| Server-only JSON keys | `SUPABASE_SECRET_KEY`, `WALLIE_ENCRYPTION_KEY`                                            | Each component's own runtime secret             |

- Web and worker use the same public configuration. The publishable key is browser-visible; the Supabase secret key bypasses RLS and must remain server-only.
- Both components must use the same Wallie encryption key for a shared database. Preserve the existing key when migrating encrypted rows; a fresh isolated staging database can use a new key.
- Point the first worker task only at an isolated staging Supabase project or branch with a verified empty queue. The worker registers and can claim jobs at startup.
- The map covers minimum shared runtime settings. GitHub App, model provider, sandbox, and worker control settings require separate review when those features are enabled. No Vercel token or sandbox provider is selected here.
- Each component has its own full `/wallie/staging/<component>/runtime-<suffix>` ARN. A later task definition must use its own ARN, exact JSON key, and reviewed **version ID**, never an implicit `AWSCURRENT` selector.

```sh
node scripts/prepare-aws-runtime-config.mjs \
  --account-id '<12-digit-account>' --region us-west-2 \
  --web-secret-arn '<full-existing-web-secret-arn>' \
  --worker-secret-arn '<full-existing-worker-secret-arn>' \
  --web-version-id '<reviewed-web-version-id>' \
  --worker-version-id '<reviewed-worker-version-id>'
```

- Output contains only variable names, ARNs, version IDs, and ECS `valueFrom` selectors. It has `deployable: false`; no values, AWS calls, IAM changes, task definitions, or services are created.
- The renderer cannot prove that a version contains those JSON keys or distinguish a canary version by metadata alone. Real-value population, payload verification, network reachability, and workload deployment need separate review and live checks. Never pass real values to this script.
- [ECS JSON-key/version selectors](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html) and [Supabase API key boundaries](https://supabase.com/docs/guides/getting-started/api-keys) define the underlying injection and exposure rules.
