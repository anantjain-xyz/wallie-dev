# Local continuity release fixture

Run `pnpm check:continuity` on Node 22 with a dedicated local Supabase stack that
has every migration applied. For the isolated acceptance stack:

```sh
WALLIE_CONTINUITY_SUPABASE_WORKDIR=/tmp/wallie499-db pnpm check:continuity
```

The launcher reads local API/database URLs and the service key from `supabase
status` internally. URLs must be loopback addresses. Keys are passed only through
the child environment and never printed, added to command arguments, or stored
in the restart manifest. The fixture rejects unrecognized external HTTP and Git
targets; GitHub responses are produced in process and Git refs live in a local
bare repository.

This gate exercises the real service, worker claims, processor, review RPCs,
checkpoint capture/storage/adoption, canonical Git promotion, and GitHub API
client. Inline comments use a real local authenticated reviewer. Only the model
runner, sandbox provider, GitHub authentication, and remote transport are
substituted. It does not model database state with an in-memory
RPC implementation. Ordinary `pnpm test` does not require a database.

Set `WALLIE_CONTINUITY_EVIDENCE_PATH=.wallie/continuity-evidence.json` to retain
nonsecret JSON proof after cleanup: exact input/output SHAs, retained refs,
run/job/artifact IDs, stage versions, the fake PR/epoch identity, distinct worker
process IDs, and successful release-state restoration and resource cleanup.

The scenario proves:

- Plan, build, requested changes, revised build, and the next stage preserve the
  original files and exact reviewed input SHAs while updating one canonical PR.
- Inline feedback is submitted once with the displayed review revision. Exact
  retries return the same batch and job; later edits/replies remain unsent and
  cannot change the saved feedback. A terminal failure creates a new manual-retry job, which binds to that same immutable generation before real processor execution. Automatic replacement attempts retain it too.
- A captured result survives a failed retained-ref push and sandbox destruction;
  checkpoint recovery proceeds while the release is paused, while canonical
  publication waits for resume.
- A replaced worker cannot overwrite the replacement's accepted checkpoint or
  PR when its delayed runner completes.
- A new Node/Vitest subprocess restores the final stage entirely from the saved
  database input and retained Git ref, without its predecessor's process memory.

The fixture enables the local release through its revision-CAS service RPC and
restores the prior enabled state/reason afterward. Release revisions remain
monotonic. It creates a unique user/workspace and removes only their fixture data,
Storage objects, sandboxes, and local files. Use an otherwise idle dedicated stack
and do not run release-toggle tests concurrently against that stack.

## Factory definition qualification

Set `WALLIE_CONTINUITY_SUPABASE_WORKDIR` to the disposable local Supabase workdir. Run the continuity and browser fixtures in sequence. The continuity worker claims jobs across that stack, including jobs queued by the browser fixture.

```sh
pnpm check:db-tests --workdir "$WALLIE_CONTINUITY_SUPABASE_WORKDIR"
WALLIE_CONTINUITY_EVIDENCE_PATH=.wallie/continuity-evidence.json pnpm check:continuity
```

| Fixture                                | What to inspect                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_definition_activation.sql`    | Publication, rollback, and enrollment serialize. An invalid receipt or revoked authority prevents activation.                                                                                       |
| `pinned_factory_stage_transitions.sql` | Stage selection, approval, and retry use the pinned order after the live pipeline changes.                                                                                                          |
| `session_attempt_manifests.sql`        | Manifests retain the exact input identities, including synthetic skill references, for each attempt.                                                                                                |
| `continuity.fixture.ts`                | Compare the enrolled revisions and attempt inputs around publication and rollback. Verify that the Node worker and Cloudflare workflow record the reviewed artifact and the applicable predecessor. |

To run the browser journey, set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` for the disposable local stack. Use the same local settings for the build and the app. Keep Playwright and `NEXT_PUBLIC_APP_URL` on `localhost` so the auth callback uses the same host. Leave `WALLIE_WORKER_WAKE_URL` and `OPENROUTER_API_KEY` unset. Install Playwright Chromium if needed.

```sh
pnpm build
WALLIE_FACTORY_QUALIFICATION=1 pnpm exec playwright test e2e/factory-qualification.spec.ts
```

The browser fixture signs in as a synthetic workspace owner. It uses the local editor, evidence reads, activation, and session admission. Its candidate receipts use deterministic provider results. It records the queued run for each new session.

The continuity fixture runs the Node processor with local provider and GitHub substitutes. In workerd, the native workflow dispatches and replays a fixture attempt with real pin loading, manifest recording, and checkpoint publication. The same review operation approves the resulting artifact. The `pinnedDefinition` record ties three activations to their test receipts, session pins, attempt IDs, and review artifacts.

In M02 an ungranted skill edit fails compilation. Workspace skill and tool grants follow in M03.
