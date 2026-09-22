# Runtime secret canary preparation

**Prepare one non-sensitive version in each empty runtime secret before testing ECS injection.** This offline helper renders requests and compares metadata; it never calls AWS or accepts real secret values.

| Contract  | Value                                                                              |
| --------- | ---------------------------------------------------------------------------------- |
| Payload   | Only `WALLIE_SMOKE_CANARY: wallie-smoke:<component>:<runId>`; public test data     |
| Version   | New shared 32-character lowercase hex `runId`, supplied as `ClientRequestToken`    |
| Label     | Explicit `AWSCURRENT`; first versions receive this AWS label                       |
| Injection | Later task maps `<full ARN>:WALLIE_SMOKE_CANARY::<runId>` to `WALLIE_SMOKE_CANARY` |
| Cleanup   | Remove only `AWSCURRENT` from that exact version; retain the secret container      |

- This proves version metadata only. A separate live task must compare the injected marker without logging it; no application startup or real credential qualification is implied.
- Keep application services stopped and serialize all secret writes throughout this canary window. Metadata checks are **not an atomic condition on the write**; concurrent writes could move `AWSCURRENT`. Stop if any version or label changes unexpectedly.
- Never supply application credentials, encryption keys, or provider tokens to this tool. Real payload preparation and migration remain later work.

## Prerequisites and access

- Merged [secret containers](AWS-SECRETS-FOUNDATION.md), [private endpoint](AWS-RUNTIME-SECRET-CONNECTIVITY.md), and [execution-role reads](AWS-EXECUTION-ROLES.md#optional-runtime-secret-access), with their live metadata checks passed.
- Each exact owned secret must have **zero versions, including deprecated versions**. Existing payloads or old canaries require separate review; this helper never replaces them.
- The existing local identity has metadata access, **not `PutSecretValue` or `UpdateSecretVersionStage`**. This PR grants no write permission. Administrator execution must preserve the exact client token; if the console cannot specify it, stop until an approved administrator CLI or separately reviewed bounded temporary write grant is available. Do not substitute an arbitrary console-generated version ID.
- AWS uses `ClientRequestToken` as the version ID. An ambiguous write is reconciled with the same request/token and metadata, never a new token or automatic retry. [PutSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html)

## Capture the empty baseline

Use a private ignored directory. Generate **one new run ID** and retain it for both components and the later injection smoke. Each component gets its own manifest:

```json
{
  "schemaVersion": 1,
  "account": "<12-digit-account>",
  "region": "us-west-2",
  "component": "web",
  "runId": "<new-32-character-lowercase-hex-id>",
  "secretArn": "<full-existing-web-runtime-secret-arn>"
}
```

Repeat with `component: worker` and its own full ARN. No additional fields or arbitrary payloads are accepted.

Capture the following using the expected non-root metadata identity and region. Select the full secret ARN, use `--no-paginate --no-cli-pager`, and retain the original output. Wrap only successful responses; timestamps describe the actual request start and response receipt.

| File in each snapshot directory    | AWS request                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `<component>-secret.json`          | `secretsmanager describe-secret --secret-id <full ARN>`                              |
| `<component>-resource-policy.json` | `secretsmanager get-resource-policy --secret-id <full ARN>`                          |
| `<component>-versions.json`        | `secretsmanager list-secret-version-ids --secret-id <full ARN> --include-deprecated` |

- All envelopes contain only `requestStartedAt`, `capturedAt`, and `response`. The versions envelope also requires **`request: { "SecretId": "<same full ARN>", "IncludeDeprecated": true }`**, copied from the actual request; AWS's response does not echo this option.
- Freshness is at most 15 minutes from request start. Captures must match ARN/name, six ownership tags, description, default encryption, no rotation/deletion/replicas/resource policy, and the expected complete version inventory. Offline checks cannot authenticate captures or timestamps.

## Prepare and verify the canary

```sh
node scripts/prepare-aws-runtime-secret-canary.mjs put-input \
  --manifest "$WALLIE_CANARY_INPUT" --readback-dir "$WALLIE_EMPTY_SNAPSHOT" \
  > "$WALLIE_CANARY_PUT_INPUT"
```

1. Review the rendered request: exact own ARN, run ID, fixed public marker, and only `AWSCURRENT`. An authorized administrator may execute it once **after merge**, preserving the exact request and response.
2. Store the successful PutSecretValue response envelope as `<component>-put.json` in a **new** snapshot. Capture all three metadata responses after the write response and preserve the original empty baseline.
3. Verify the exact single version/label; never call `GetSecretValue` for this metadata check:

```sh
node scripts/prepare-aws-runtime-secret-canary.mjs verify \
  --manifest "$WALLIE_CANARY_INPUT" --readback-dir "$WALLIE_POPULATED_SNAPSHOT"
```

Use these same raw metadata files for the separately reviewed injection smoke. Version-ID pinning prevents later stage-label movement from silently selecting another value. [ECS JSON-key/version selection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)

## Remove the label after the smoke

Stop the canary tasks and remove their temporary definitions/permissions using their runbook. Then freshly capture all three metadata responses into a new cleanup snapshot.

```sh
node scripts/prepare-aws-runtime-secret-canary.mjs cleanup-input \
  --manifest "$WALLIE_CANARY_INPUT" --readback-dir "$WALLIE_CLEANUP_SNAPSHOT" \
  > "$WALLIE_CANARY_CLEANUP_INPUT"
```

- Require exactly the known version with only `AWSCURRENT`; the rendered request contains `RemoveFromVersionId` and **no `MoveToVersionId`**. An authorized administrator removes that label from that version only. If the label moved, stop; never remove or restore a foreign label/version.
- Preserve the successful response as `<component>-cleanup.json`; capture metadata again after its response. Run `verify-cleanup` with that new snapshot to require the retained canary version has no labels and no other version exists.
- Removing the last label deprecates the version; AWS may delete deprecated versions later. **Cleanup does not restore an empty secret or delete its stored canary value immediately.** A subsequent `put-input` rejects that retained version. [Label removal](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_UpdateSecretVersionStage.html)
