# Qualify benchmark replay on production

Use a dedicated test workspace and factory, the existing `anantjain-xyz/wallie-dev` repository, and unique test refs. Run one comparison with one captured task, two harnesses, and two repetitions. This yields exactly four frozen trial IDs.

## Prepare the deployment

- Verify the active Vercel web and Cloudflare Worker deployments include the M08 qualification merge. Confirm Supabase applied the matching forward migrations. Check the two deployments separately. See [Cloudflare Worker deployment](../deployment/cloudflare-worker.md#production-deployment).
- In the test workspace, connect the existing GitHub repository and the Vercel Sandbox project. Use a unique qualification base branch and keep production issue, chat, and deploy integrations disconnected from the test factory.
- Prepare equivalent saved factory drafts for Codex and OpenCode. Use a dated OpenAI model with Responses access in your test project. Set the bare model ID for Codex and `openai/<same-dated-model>` for OpenCode. Keep the repository, pipeline, stage, instructions, and validation equivalent. The offline fixtures use `gpt-4.1-2025-04-14`. Check current availability before choosing it. [OpenAI model deprecations](https://developers.openai.com/api/docs/deprecations)
- Connect the operator’s credential for each harness, run **Settings → Verify setup → Sandbox capability → Run capability check**, and run the candidate smoke test before publishing each draft. Keep both published revision IDs and capability receipts. Use their exact CLI versions to build the digest-pinned image, then check both executable digests in the connected Vercel project. The factory’s benchmark inference key is provisioned separately below. [Factory activation](factory-definition-activation.md) · [Prepare a qualified benchmark replay image](qualified-benchmark-replay.md)
- Set the Vercel web image profile and verify the Workerd relay origin and dispatch settings. Connect a dedicated OpenAI project key to the test factory. Record the connection revision and keep the key in your secret manager. In OpenAI project **Limits**, configure model access, rate limits, and a monthly spend limit with **Enforce a hard limit** enabled. Allow for provider enforcement lag when choosing that limit. Wallie admits work against its reserves and holds the reserve when dollar cost is unavailable. [OpenAI project limits](https://help.openai.com/en/articles/9186755-managing-projects-in-the-api-platform#set-spend-limits-and-alerts)
- Publish a new `blocked` replay policy for the test factory with no fixtures. Use the current policy ID for the compare-and-set or SQL `NULL` on the first revision. Record the resulting ID and digest.
- To test scoring in the same run, configure the test workspace’s dedicated judge profile and publish a scorer for retained artifact or validation evidence. Select the scorer in the frozen experiment and leave ordinary source-run sampling disabled for the rehearsal. Use a separate evaluation ceiling and record the judge and scorer revision IDs. [Scorer enrollment](factory-scorer-evaluation.md#enrollment-and-rollback)

### Prepare a source run

Reuse an eligible build from the test factory if its saved input and pull-request base already point to a qualification branch. For a new source run, create a small fixture branch in the existing repository. Its first commit disables automatic Vercel deployments for the fixture and any source branch created from it. [Vercel Git configuration](https://vercel.com/docs/project-configuration/git-configuration#gitdeploymentenabled)

```bash
run_id=$(date -u +%Y%m%dT%H%M%SZ)
test_base="codex/m08-qualification-$run_id"
source_dir=$(mktemp -d)
git init -q --initial-branch="$test_base" "$source_dir"
printf '# M08 qualification\nBefore replay.\n' > "$source_dir/README.md"
printf '{"git":{"deploymentEnabled":false}}\n' > "$source_dir/vercel.json"
git -C "$source_dir" add README.md vercel.json
git -C "$source_dir" commit -m 'Seed isolated M08 qualification source'
source_sha=$(git -C "$source_dir" rev-parse HEAD)
source_tree=$(git -C "$source_dir" rev-parse "$source_sha^{tree}")
git -C "$source_dir" push --force-with-lease="refs/heads/$test_base:" \
  https://github.com/anantjain-xyz/wallie-dev.git "$source_sha:refs/heads/$test_base"
```

Wallie uses the connected repository’s saved default branch for a new source run. In the production SQL editor, read and record the current `default_branch` of the dedicated test factory's `public.github_repositories` row. Temporarily set that row to the fixture branch with the exact prior value as a guard. Leave GitHub’s default branch and project settings alone. Keep the test repository connection steady until the run has captured its input.

```sql
update public.github_repositories
set default_branch = '<qualification-base-branch>'
where (workspace_id, factory_id, id) =
  ('<test-workspace-uuid>'::uuid, '<test-factory-uuid>'::uuid, '<repository-row-uuid>'::uuid)
  and full_name = 'anantjain-xyz/wallie-dev'
  and default_branch is not distinct from '<previous-default>'
returning id, default_branch;
```

Confirm the update returned one row. Start a normal test build and ask it to append `M08 replay verified` to `README.md` and write a Markdown result. Keep `vercel.json` intact. Record the completed run ID. In the SQL editor, check the exact job input and compare `input_sha` with `source_sha` from the fixture push.

```sql
select run.id, pinned.base_branch, pinned.input_sha
from public.agent_runs run
join public.sessions owner on (owner.workspace_id, owner.id) = (run.workspace_id, run.session_id)
join public.session_job_git_inputs pinned on (pinned.workspace_id, pinned.session_id, pinned.job_id) =
  (run.workspace_id, run.session_id, run.agent_job_id)
where (owner.workspace_id, owner.factory_id, run.id) =
  ('<test-workspace-uuid>'::uuid, '<test-factory-uuid>'::uuid, '<source-run-uuid>'::uuid);
```

Verify any source pull request targets `test_base` and leave it unmerged. Restore the same repository row using the guarded update above with the previous and new branch values swapped. If the prior value was SQL `NULL`, use `NULL` directly. For an existing source run, set `test_base` to its pinned branch, set `run_id` to a unique label for the baseline files, and fetch the retained ref. Use `git rev-parse "$source_sha^{tree}"` with its exact starting commit to obtain the expected tree. Record the test refs and pull requests before admitting the replay. These form the isolation baseline.

```bash
git ls-remote https://github.com/anantjain-xyz/wallie-dev.git > "$run_id-refs-before.txt"
gh pr list --repo anantjain-xyz/wallie-dev --base "$test_base" --state all \
  --json number,state,headRefName,baseRefName > "$run_id-prs-before.json"
```

### Connect the inference key

Keep the test key in your secret manager. From the signed-in test factory's browser tab, run the following code in the console. Replace the workspace and factory IDs first. Enter the key at the browser prompt. Retain only the returned revision and public image profile.

```js
const benchmark = "/api/workspaces/<workspace-uuid>/factories/<factory-uuid>/benchmarks";
const connectionPath = benchmark + "/inference-connection";
{
  const apiKey = window.prompt("Enter the OpenAI test project key");
  if (!apiKey) throw new Error("A test project key is required.");
  const response = await fetch(connectionPath, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "connect", apiKey }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Connection request failed");
  console.log(result.connection);
}
```

### Publish the blocked replay policy

Use the SQL editor in the selected deployment as the database operator. Replace all three IDs and retain the returned policy ID and digest. The actor must be your active factory manager identity.

```sql
begin;
with scope(workspace_id, factory_id, actor_id) as (
  values ('<test-workspace-uuid>'::uuid, '<test-factory-uuid>'::uuid, '<your-user-uuid>'::uuid)
), latest as (
  select scope.*, (
    select revision.id
    from public.factory_benchmark_replay_policy_revisions revision
    where (revision.workspace_id, revision.factory_id) = (scope.workspace_id, scope.factory_id)
    order by revision.revision_number desc
    limit 1
  ) as expected_revision_id
  from scope
)
select policy.id, policy.revision_number, policy.policy_digest, policy.profile
from latest
cross join lateral public.publish_factory_benchmark_replay_policy(
  latest.workspace_id, latest.factory_id, latest.actor_id, 'blocked',
  latest.expected_revision_id, '{}'::uuid[]
) policy;
commit;
```

## Capture, freeze, and run

1. Open the eligible source run from the dedicated test factory. Record the authorized source run’s refs and pull request before admitting replays. Use the pinned fixture input and acceptance criteria from the source preparation above.
2. Open the completed run and choose **Add to benchmark**. Select **New suite** and **Regression**. For the example source, require exactly one added line `M08 replay verified` in `README.md` and leave `vercel.json` intact. Save, confirm the task is eligible, and record its **Starting checkout**, **Retained ref**, expected tree from Git, task revision, and suite revision.
3. In the suite’s comparison form, select the blocked policy and choose **Cloudflare Workers** for both candidates. Confirm the dated model, two CLI versions and digests, Vercel connection, and both definition revisions. Choose two repetitions and record the seed and deadline. Optionally select an immutable configured scorer revision and assign a separate evaluation ceiling. Use a scorer that accepts the retained artifact and validation evidence.
4. Freeze the comparison. Record its ID. Confirm four planned and four eligible trials and that the two candidates share the planned seed for each repetition.
5. Configure the schedule using the test factory’s authenticated benchmark schedule endpoint. Set `runnerRevision` to `openai-responses-v1`, supply the recorded `inferenceConnectionRevision`, and set a positive execution reserve and concurrency of one. Set `maxAdmittedTrials` to four, and set the experiment limit to enough for four holds plus any chosen evaluation ceiling. Retain the configuration response.
6. After admission, use **Edit suite** to save a new revision with a different name. Open the existing comparison again and confirm it still displays its original revision and four trials. Pause admission, verify no new trials enter the queue, then resume. Allow already admitted jobs time to settle. Test cancellation separately on a second frozen comparison. Cancel once it has a running or queued trial and verify canceled outcomes appear with their own trial IDs. A canceled comparison needs a new experiment ID to run again.
7. For the primary comparison, expect four eligible, admitted, and completed trials with none pending. Open each retained trial and compare its input tree and exact model with the recorded pins and inference receipts. Verify the expected change in **Output diff** and inspect its transcript. Check that the accepted output commit and tree match the private checkpoint. The live lane validates changed-tree lineage. Browser evidence is available when an exact receipt exists for the accepted output. The frontier should identify incomplete dollar coverage and withhold a cost recommendation when all candidates have unpriced executions.
8. Choose **Create result export**. Download the manifest and every trial and configuration part. Verify each advertised page SHA-256, all four unique materialized trial IDs, and the execution and evaluation subtotals. Reopen the original export after editing the suite. Its bytes must match the first download.
9. From a separate authorized account with no access to the test factory, confirm the shared trial and export URLs fail. Restore the original test account and confirm its links still work.

## Schedule API example

Run authenticated requests from a signed-in Wallie browser session. Replace the IDs and budgets with those of your isolated test experiment.

```js
const schedule = benchmark + "/experiments/<experiment-uuid>/schedule";

async function updateSchedule(command) {
  const response = await fetch(schedule, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Schedule request failed");
  return result;
}

await updateSchedule({
  action: "configure",
  runnerRevision: "openai-responses-v1",
  inferenceConnectionRevision: "<connection-revision-uuid>",
  executionReserveUsd: 0.5,
  evaluationReserveUsd: 0,
  budgetLimitUsd: 2,
  factoryConcurrencyLimit: 1,
  maxAdmittedTrials: 4,
});
```

Read current state with `GET` on the same schedule endpoint. Send `{ action: "pause" }`, `{ action: "resume" }`, and `{ action: "cancel" }` individually at the points described above. If scoring is enabled, select a separate evaluation ceiling at freeze, set `evaluationReserveUsd` to a positive amount, and increase `budgetLimitUsd` by the evaluation ceiling.

Save the untouched comparison response before editing the suite. Run this in the authenticated browser tab. `schedule` comes from the example above.

```js
const baseline = await fetch(schedule.replace(/\/schedule$/, "/comparison"), {
  credentials: "same-origin",
});
if (!baseline.ok) throw new Error("Comparison could not be read");
const downloadUrl = URL.createObjectURL(await baseline.blob());
const download = document.createElement("a");
download.href = downloadUrl;
download.download = "comparison-before-edit.json";
download.click();
setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
```

### Check the retained inference receipts

Run this read in the test deployment's SQL editor. Use the exact experiment ID and factory scope. Keep the returned receipts with the report.

```sql
select frozen.trial_id, frozen.repetition, frozen.seed, candidate.harness,
  candidate.canonical_model_key, trial.status, result.input_commit_sha,
  result.input_tree_sha, result.output_commit_sha, binding.ready_at, binding.closed_at,
  receipt.id as inference_receipt_id, receipt.observed_model, receipt.request_count,
  receipt.unavailable_usage_count, receipt.input_tokens, receipt.output_tokens,
  reservation.cost_provenance, reservation.actual_usd, reservation.reserve_usd
from public.factory_benchmark_experiment_trials frozen
join public.factory_benchmark_experiment_candidates candidate using
  (workspace_id, factory_id, experiment_id, candidate_key)
left join public.factory_benchmark_schedule_trials reservation using
  (workspace_id, factory_id, experiment_id, trial_id)
left join public.factory_benchmark_trials trial on (trial.workspace_id, trial.factory_id, trial.id) =
  (frozen.workspace_id, frozen.factory_id, frozen.trial_id)
left join public.factory_benchmark_trial_results result on result.trial_id = trial.id
left join internal.factory_benchmark_live_sandbox_bindings binding on binding.trial_id = trial.id
left join internal.factory_benchmark_inference_receipts receipt on receipt.id = result.inference_receipt_id
where (frozen.workspace_id, frozen.factory_id, frozen.experiment_id) =
  ('<test-workspace-uuid>'::uuid, '<test-factory-uuid>'::uuid, '<experiment-uuid>'::uuid)
order by candidate.comparison_position, frozen.repetition;
```

For each successful trial, expect a closed sandbox binding after `ready_at`, a nonempty inference receipt, and `openai/` plus `observed_model` matching the frozen `canonical_model_key`. Complete token coverage has `unavailable_usage_count = 0`. If some responses lack usage, the receipt retains its known partial token counts and the aggregate usage stays unavailable. Budget reserves are separate from observed cost.

## Verify isolation and close the test

- Compare repository refs, pull requests, and production issue, chat, and deploy activity against the starting baseline. Only the authorized source capture may write the qualification refs. Replay publishes private evidence only.
- Confirm `ready_at` for each successful trial. The worker marks the sandbox ready after its denied-egress probes and signed relay binding pass. The sandbox uses the authenticated Responses relay for inference.
- To check missing snapshot handling in production, capture another test run whose original source or context receipt is already missing. Freeze it separately and confirm that the ineligible trial still has a frozen ID, an eligibility reason, and no admitted execution. The disposable suite exercises a ref that disappears after freeze.
- For recovery rehearsal, use a disposable dispatch environment or an approved worker maintenance window. Pause the test schedule before the next slot is admitted. Record the frozen trial IDs and reservations, roll only the isolated dispatcher, and resume. If a claimed workflow was interrupted, wait for its original deadline and reconciliation. Verify the next eligible ID can start, earlier terminal IDs do not execute twice, and spent, reserved, and unknown usage reconcile in a newly captured export. Keep the normal shared production dispatcher running during the live test.
- Record the web and Worker deployment commits, experiment ID, trial IDs, pinned revisions, receipt IDs, export ID and hashes, and cleanup results. Keep source, credentials, and connection strings out of the evidence report.
- Cancel the qualification schedules that still have unfinished work. Revoke the dedicated inference connection and revoke its OpenAI project key. Confirm the disposable replay sandboxes stopped. Retain the isolated Git refs and test history for reproducibility.

To revoke the exact Wallie connection from the signed-in factory tab:

```js
const revocation = await fetch(connectionPath, {
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "revoke", connectionRevision: "<connection-revision-uuid>" }),
});
const revoked = await revocation.json();
if (!revocation.ok || revoked.revoked !== true) throw new Error("Connection was not revoked");
```

Pause stops new admissions and claims while already claimed work can finish. Cancel retires the test comparison and preserves its results and accounting. For an incident affecting multiple experiments, use the documented worker dispatch and execution-admission controls. Shared dispatch controls also affect production work. [Worker rollback](../deployment/cloudflare-worker.md#rollback)

## Check the downloaded export

Save the manifest, all trial parts, and all configuration parts in one directory. Keep the original download filenames. From the Wallie checkout, run the verifier against the manifest. Replace the path and export ID with the values from the download.

```bash
python3 scripts/verify-benchmark-qualification-export.py \
  '<download-directory>/benchmark-<export-id>-manifest.json' --expected-trials 4
```

The verifier checks part sizes and SHA-256 values, the paired frozen slots, each configuration and status tally, and measured, estimated, reserved, and unavailable spend across execution and evaluation. Save an authenticated comparison response before editing the suite and pass its filename as `--original-snapshot` to compare the original frozen identity with the final export. Compare the saved and re-downloaded bytes for the same export ID after the edit.
