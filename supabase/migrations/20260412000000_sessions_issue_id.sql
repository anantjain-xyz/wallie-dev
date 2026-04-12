-- Backend cutover (PR 3): link sessions to their anchor issue.
--
-- The previous PRs (schema foundation + UI facade) shadow-wrote rows to
-- `public.sessions` but kept `public.pipeline_issues` as the source of truth
-- for phase / phase_status / artifacts. To flip the processor and the Slack
-- handlers onto `sessions`, we need a way to locate a session from an
-- agent_jobs row — agent_jobs keys on `issue_id`, so we add a nullable FK on
-- sessions back to the anchor issue.
--
-- Nullable because future work (Flow B done right, agent_jobs.session_id
-- column, eventual drop of the issues table) will remove the anchor-issue
-- pattern entirely. For this cutover we keep creating an anchor issue per
-- session, but writes + reads for the pipeline flow go through sessions.
alter table public.sessions
  add column issue_id uuid references public.issues(id) on delete cascade;

create index sessions_issue_id_idx
  on public.sessions (issue_id)
  where issue_id is not null;

-- The session ↔ anchor issue relationship is 1:1 in practice: every Slack
-- mention and every "new session" creates exactly one issue and one session.
-- Enforce it so a stray double-insert shows up as a conflict instead of
-- silently producing two sessions that fight over the same agent_job.
create unique index sessions_issue_id_unique_idx
  on public.sessions (issue_id)
  where issue_id is not null;
