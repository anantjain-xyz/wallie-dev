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
  cannot change the saved feedback used by either worker attempt.
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
