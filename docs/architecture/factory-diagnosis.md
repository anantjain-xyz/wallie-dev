# Factory diagnosis

A factory manager starts a diagnosis from a [failure cohort](factory-failure-cohorts.md).
Admission freezes up to 12 accessible members, with one member per session.
The diagnosis records the selected agent prompt, factory definition, skills,
and approved inference profile by revision. Each frozen member identifies its
producing run, attempt, step, agent, and source receipt where available.

The worker sends structured receipt metadata and the selected diagnosis prompt
to the approved inference provider. Source bodies, transcripts, and private
assets stay behind their existing readers. Observations come from the frozen
records. The model returns tentative claims tied to cited producing steps.
Wallie derives the observation summary and uncertainty from the frozen records,
including missing support and mixed producing configurations.

| Boundary     | Enforcement                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission    | Current factory manager and available evidence. One pending diagnosis per cohort. A repeated request ID returns the original receipt.               |
| Execution    | One leased inference request, at most 40,000 request bytes, 1,200 output tokens, and 60 seconds. No tool or repository access enters the request.   |
| Completion   | A claim cites only frozen members with an observed producing step. The worker retains each measured usage field the provider supplies.              |
| Cancellation | The worker polls current authority and evidence while inference runs. Cancellation or revoked access aborts the request and fences late completion. |
| Reads        | Current factory membership and source visibility gate the receipt. A withheld source hides the frozen evidence and diagnosis result.                |

The commands share the API prefix
`/api/workspaces/{workspaceId}/factories/{factoryId}`. Both POST endpoints
require the configured Wallie origin. The queue request requires JSON.

| Method and path                             | Operation                                                  |
| ------------------------------------------- | ---------------------------------------------------------- |
| `POST /failure-groups/{cohortId}/diagnoses` | Queue a diagnosis with `requestId` and `promptRevisionId`. |
| `GET /diagnoses/{diagnosisId}`              | Read the scoped diagnosis receipt.                         |
| `POST /diagnoses/{diagnosisId}/cancel`      | Cancel through the factory manager's account.              |

## Verification

Use an exclusive loopback Supabase project with current migrations and a local
`psql` client. The smoke seeds disposable evidence, calls the real Node worker
through PostgREST, and intercepts the provider request in-process.

```sh
WALLIE_FACTORY_DIAGNOSIS_DB_WORKDIR=/path/to/disposable-project \
  pnpm exec vitest run --config vitest.factory-runtime.config.ts \
  test/release/factory-diagnosis.node.fixture.ts
```
