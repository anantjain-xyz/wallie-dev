-- Lock down worker_heartbeats: fail-closed policy + explicit revoke.
--
-- The audit ticket (WAL-11) framed this as a tripwire — `using (true)` policy
-- but no grant in the migration file, so "service-role only today". That was
-- not the whole picture. Supabase's default privileges on the `public` schema
-- grant arwdDxtm (full access) to `anon`, `authenticated`, and `service_role`
-- on every table created there, unless explicitly revoked. 20260422000000_init
-- revokes those defaults for ~17 tables but skipped `worker_heartbeats`. With
-- the default grant intact and the policy permitting everything, an anon
-- connection through the Supabase API can already read every row, including
-- `active_job_id` and `metadata`. Confirmed locally with `set role anon`.
--
-- Defense-in-depth: lock down both axes the way every other service-role-only
-- table is locked down in init.sql.
--   1. `revoke all ... from anon, authenticated` — matches the explicit revoke
--      pattern used for profiles, workspaces, sessions, agent_jobs, etc.
--   2. Replace `using (true)` with `using (false)` — even if a future migration
--      re-adds a grant (or someone resets default privileges), the policy
--      itself denies every row.
-- service_role bypasses RLS, so the worker code paths that actually use this
-- table are unaffected.
--
-- If the dashboard ever needs to display worker heartbeats, replace this with
-- a real membership-scoped policy (analogous to the `*_select_membership`
-- policies in init.sql) and add the corresponding grant.

revoke all on public.worker_heartbeats from anon, authenticated;

drop policy worker_heartbeats_select on public.worker_heartbeats;

create policy worker_heartbeats_select
  on public.worker_heartbeats
  for select
  using (false);
