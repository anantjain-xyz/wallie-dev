# Qualify the factory improvement loop

Use an exclusive loopback Supabase project and a compiled local Wallie app. The fixture carries the same cohort, proposal revision, paired validation, published configuration, and admission pins through the loop.

| Step             | Evidence                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare          | Three independent retained production failures, a bounded diagnosis, the compiler’s baseline and candidate digests, and targeted and holdout comparison receipts. The fixture uses synthetic inference, sandbox, and cost inputs. |
| Publish          | The production publication route records a real App-authored draft against a unique base in `anantjain-xyz/wallie-dev`. The draft changes only the factory definition file.                                                       |
| Review and adopt | An independent GitHub user with current write access approves the exact draft head after it is ready. Wallie verifies the hosted merge and activates the exact tested bytes.                                                      |
| Restore          | The owner uses the shared Settings rollback. The proposal keeps its evidence, previously admitted sessions keep their pins, and a new session uses the restored activation.                                                       |

## Prepare the local evidence

- Start Supabase for an empty disposable project without demo jobs or workers. Set `M10_SUPABASE_DIR` to its workdir. Compile Wallie and serve it at `M10_APP_ORIGIN`. Set the app’s `NEXT_PUBLIC_APP_URL` to that exact loopback origin.
- Configure the app and fixture for that Supabase project. Use the same `WALLIE_ENCRYPTION_KEY` in both processes. Have `psql` and Perl available. Install the Chromium binary with `pnpm exec playwright install chromium`.
- Set `M10_STATE` to an unused path in a private local directory outside the checkout. The CLI creates the JSON file. Keep the same disposable database and state file across review.
- A separately managed loopback stack can supply its Supabase status JSON with `--status-file` in place of `--workdir`. Set its file mode to `0600` because the status includes local connection credentials.
- Set `M10_LOCAL_DB_URL` to the same status file's `DB_URL` for the browser run. Use the project's direct loopback PostgreSQL connection or a native PostgreSQL URL with `?host=` set to the URL-encoded, owner-only `/private/tmp/wallie-…/socket` directory.

```sh
node --import ./scripts/register-server-only.mjs --import tsx \
  scripts/qualify-factory-improvement-loop.ts prepare \
  --workdir "$M10_SUPABASE_DIR" --state "$M10_STATE" --app-origin "$M10_APP_ORIGIN"

pnpm check:db-tests --workdir "$M10_SUPABASE_DIR" \
  "$PWD/supabase/tests/factory_improvement_validation.sql" \
  "$PWD/supabase/tests/factory_improvement_publication.sql" \
  "$PWD/supabase/tests/factory_improvement_adoption.sql" \
  "$PWD/supabase/tests/factory_improvement_outcomes.sql"
```

The regression fixtures exercise a held-out regression, stale authorization and activation, and altered candidate bytes in rollback-only tests. The live candidate keeps its frozen comparison results.

If preparation is interrupted, rerun `prepare` with the same `--state` and disposable Supabase project to restore the execution gate owned by that run. The command reports when cleanup is complete. Start the next preparation with a fresh disposable project and an unused state path.

## Publish and resume after review

1. Run the local app and the qualification commands with the same configured GitHub App. Install that App with Contents and Pull Requests write access for `anantjain-xyz/wallie-dev`. Run `prepare --live` with a fresh state file so the disposable workspace starts with the verified installation.
2. Save the reported draft and exact head. If publication is pending or the response is lost, rerun `publish` with the same state file. Wallie recovers the same publication intent.
3. In GitHub, mark the draft ready. Have an independent eligible human approve the exact head. Use a merge commit or squash merge into the named fixture base while it still points at the published base commit.
4. Set `M10_PROOF_DIR` to a dedicated local path outside the checkout. Create it once with `mkdir -m 700 "$M10_PROOF_DIR"`.
5. Resume the browser fixture against the same local app and database. It verifies that it can write screenshots to the private directory before signing in.

```sh
node --import ./scripts/register-server-only.mjs --import tsx \
  scripts/qualify-factory-improvement-loop.ts publish \
  --workdir "$M10_SUPABASE_DIR" --state "$M10_STATE"

WALLIE_FACTORY_IMPROVEMENT_MANIFEST="$M10_STATE" \
WALLIE_FACTORY_IMPROVEMENT_DB_URL="$M10_LOCAL_DB_URL" \
WALLIE_FACTORY_IMPROVEMENT_PROOF_DIR="$M10_PROOF_DIR" \
PLAYWRIGHT_BASE_URL="$M10_APP_ORIGIN" \
  pnpm exec playwright test --config e2e/factory-improvement-loop-qualification.config.ts
```

Keep the state file and the fixture PR for review. The state file records evidence IDs, digests, refs, and the PR identity. If Chromium stops after submitting adoption or rollback, rerun the same browser command. Keep the same state file, database, app origin, proof directory, and private `${M10_STATE}.browser-progress.json` file. The browser checks the saved submission and actual activation before continuing. After rollback, the browser reuses `03-shared-settings-rollback-dark-mobile.png` from the original proof directory. A missing Settings screenshot fails the run. Local app and database credentials come from the process environment or the disposable Supabase project. Close a stopped fixture’s local services through their scoped project controls after verification.

## Pause production admission independently

Configure one custom rule per operation in the Wallie Vercel project. Combine **Environment** equals **Production**, **Method** equals **POST**, and **Route** equals the framework path below. Enable the rule with the **Log** action and select **Review Changes** then **Publish** before checking the matches. To pause admission, switch the selected rule to **Deny** and publish. To resume, disable that rule and publish again. History reads and the shared Settings rollback use separate routes. [Vercel custom rules](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules) · [Rule configuration](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration)

| Operation   | Vercel Route                                                                                                                        | Work already admitted                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Diagnosis   | `/api/workspaces/[workspaceId]/factories/[factoryId]/failure-groups/[cohortId]/diagnoses`                                           | Cancel an exact queued or running diagnosis through its existing `/diagnoses/[diagnosisId]/cancel` action when needed.          |
| Publication | `/api/workspaces/[workspaceId]/factories/[factoryId]/improvement-proposals/[proposalId]/revisions/[proposalRevisionId]/publication` | A request that entered the handler can finish. A saved intent remains available for recovery.                                   |
| Adoption    | `/api/workspaces/[workspaceId]/factories/[factoryId]/improvement-proposals/[proposalId]/revisions/[proposalRevisionId]/adoption`    | An activation already inside the database transaction can finish. The proposal and shared rollback preserve its audit evidence. |

Each rule governs HTTP ingress. Existing worker leases and trusted service RPCs keep their own authority and budgets.
