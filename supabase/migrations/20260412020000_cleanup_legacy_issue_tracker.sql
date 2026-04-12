-- Cleanup (PR 4): drop the legacy classical-issue-tracker surface area.
--
-- PR 3 (backend cutover) made `sessions` the source of truth for every
-- pipeline read/write. `pipeline_issues`, `pipeline_artifacts`, the
-- `approve_pipeline_phase` RPC, `issue_comments`, `issue_links`, and the
-- classical columns on `issues` are now unreferenced by application code.
-- This migration drops all of them.
--
-- Things we are NOT dropping in this migration:
--   - `issues` itself. The wallie panel (`features/wallie/*`), the github
--     webhook pull-request tracker (`github_issue_branches`), and
--     `agent_jobs.issue_id` still key off anchor issue rows. A later PR can
--     migrate those off `issues` entirely.
--   - `github_issue_branches`. Same reason — github webhooks still write to
--     it, session detail joins through `sessions.issue_id` to read it.
--   - `features/issues/*` in the application code — kept for the types and
--     helpers the wallie panel imports.
--
-- Order matters: drop child objects before their parents so cascades don't
-- surprise us.

-- -------------------------------------------------------------------------
-- 1. Stop the legacy pipeline table from broadcasting realtime changes.
-- -------------------------------------------------------------------------
do $$
declare
  publication_name text := 'supabase_realtime';
begin
  if exists (
    select 1 from pg_publication where pubname = publication_name
  ) and exists (
    select 1
    from pg_publication_tables
    where pubname = publication_name
      and schemaname = 'public'
      and tablename = 'pipeline_issues'
  ) then
    execute format('alter publication %I drop table public.pipeline_issues', publication_name);
  end if;
end;
$$;

-- -------------------------------------------------------------------------
-- 2. Drop the legacy pipeline tables and their RPC.
-- -------------------------------------------------------------------------
drop table if exists public.pipeline_artifacts cascade;
drop table if exists public.pipeline_issues cascade;
drop function if exists public.approve_pipeline_phase(uuid, uuid, integer);

-- `pipeline_phase` is no longer referenced by any table or function now
-- that pipeline_issues is gone. `session_phase` is its replacement.
drop type if exists public.pipeline_phase;

-- -------------------------------------------------------------------------
-- 3. Drop issue_comments and issue_links (discussion moves to Slack + Linear).
-- -------------------------------------------------------------------------
drop table if exists public.issue_comments cascade;
drop table if exists public.issue_links cascade;
drop type if exists public.issue_link_type;

drop function if exists internal.enforce_issue_comment_defaults_and_refs();
drop function if exists internal.enforce_issue_link_refs();

-- -------------------------------------------------------------------------
-- 4. Rewrite the issues trigger so it no longer references the
--    about-to-be-dropped `assignee_member_id` column.
-- -------------------------------------------------------------------------
create or replace function internal.enforce_issue_defaults_and_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_member_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if tg_op = 'INSERT' then
      current_member_id := internal.current_workspace_member_id(new.workspace_id);

      if current_member_id is null then
        raise exception 'Authenticated user is not an active member of workspace %', new.workspace_id
          using errcode = '42501';
      end if;

      if new.creator_member_id is null then
        new.creator_member_id := current_member_id;
      elsif new.creator_member_id <> current_member_id then
        raise exception 'creator_member_id must match the current workspace member'
          using errcode = '42501';
      end if;
    elsif new.creator_member_id is distinct from old.creator_member_id then
      raise exception 'creator_member_id is immutable after insert'
        using errcode = '42501';
    end if;
  end if;

  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.workspace_members',
    new.creator_member_id,
    'creator_member_id'
  );
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.github_repositories',
    new.github_repository_id,
    'github_repository_id'
  );

  return new;
end;
$$;

-- -------------------------------------------------------------------------
-- 5. Drop the classical tracker columns on issues.
--    CASCADE so indexes on these columns (priority_rank, status, assignee,
--    etc.) get cleaned up with them.
-- -------------------------------------------------------------------------
alter table public.issues
  drop column if exists status cascade,
  drop column if exists priority cascade,
  drop column if exists priority_rank cascade,
  drop column if exists estimate_points cascade,
  drop column if exists assignee_member_id cascade,
  drop column if exists plan_md,
  drop column if exists design_md;

-- -------------------------------------------------------------------------
-- 6. Drop the classical enums now that nothing references them.
-- -------------------------------------------------------------------------
drop type if exists public.issue_status;
drop type if exists public.issue_priority;
