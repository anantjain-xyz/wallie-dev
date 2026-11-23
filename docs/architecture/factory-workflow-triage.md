# Accepted triage scope

Triage begins as a normal specification session. Its named agent proposes scope and acceptance criteria from the run's permitted evidence. A linked question pauses ambiguous work in the existing Inbox and review flow. Unsupported work leaves a reviewable reason and cannot enroll the graph.

## Configuration

- Use an activated definition with the named implementation agent for triage. Register a compiled graph against that exact definition revision and digest. Its first node must be a human gate with the same approval policy as the selected stage.
- Call the service command `configure_factory_workflow_triage` with the authenticated manager's user ID, exact stage and graph revision IDs, workflow digest, and expected configuration version. Start with version `0`. An exact replay returns the saved version. A stale change must be reloaded before submitting again.
- Create a session with specification drafting enabled and select the configured stage as the sole stage. Human and machine intake use the same pin. A later configuration applies to new sessions. To dispatch the approved path automatically, connect the entry gate directly to a configured foreman route.

| Boundary            | Retained proof                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Scope review        | Exact artifact version, human approval, named prompt revision, adopted source and frozen evidence manifest  |
| Route dispatch      | Workflow revision, first foreman occurrence, approved scope and criteria, and a recoverable ownership lease |
| Delegated execution | Approved scope receipt, immediate parent source and exact child run-context fingerprint on every attempt    |

Scope, criteria, and cited evidence remain visible in Review Brief and Full artifact. The foreman receives the approved scope as untrusted task data. The child receives the same scope as required context alongside its own task. Graph ownership and the existing grants and budget checks still govern execution.

## Qualification

Use a disposable local Supabase project with the current migrations and `psql`. Install Playwright Chromium and set the local app URL, Supabase URL, publishable key, service key, encryption key, and `WALLIE_SPECIFICATION_DATABASE_URL`. Keep the worker stopped and clear external wake and model settings while the fixture owns the attempts.

```sh
pnpm check
pnpm check:db-tests supabase/tests/factory_workflow_triage_scope.sql
pnpm build
WALLIE_TRIAGE_E2E=1 pnpm exec playwright test e2e/session-specification.spec.ts
```

The browser uses real sign-in, Inbox, clarification, approval, and delegated review surfaces. It supplies deterministic inference through the native settlement command and verifies the child receives the retained criteria.
