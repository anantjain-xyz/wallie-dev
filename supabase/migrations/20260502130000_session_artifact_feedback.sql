-- Decouple rejection feedback from the artifact row it was recorded against.
--
-- `session_artifacts.feedback_text` was carrying two roles: an audit record of
-- *why* a version was rejected, and the input feedback the next stage attempt
-- reads from. The two roles only worked because rejection and the next run
-- happen serially — a concurrent rejection or a future "edit feedback after
-- the fact" feature would silently break the read path. Move feedback into
-- its own table keyed on `(session_id, stage_id, target_version)` so the
-- lifecycle is explicit.

create table public.session_artifact_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  -- stage_id may be null after a stage is deleted; stage_slug snapshot keeps
  -- the history readable. Inserts always set both.
  stage_id uuid references public.pipeline_stages(id) on delete set null,
  stage_slug text not null,
  target_version integer not null,
  feedback_text text not null,
  created_at timestamptz not null default now(),
  constraint session_artifact_feedback_target_version_positive_check
    check (target_version > 0),
  constraint session_artifact_feedback_unique_target
    unique (session_id, stage_id, target_version)
);

create index session_artifact_feedback_session_stage_version_idx
  on public.session_artifact_feedback (session_id, stage_id, target_version desc);

-- Backfill any existing rejection feedback so we don't drop reviewer text on
-- the floor. Pre-launch this is a no-op; defensive for any environment that
-- already accumulated rejections against the old column.
insert into public.session_artifact_feedback (
  workspace_id,
  session_id,
  stage_id,
  stage_slug,
  target_version,
  feedback_text,
  created_at
)
select
  a.workspace_id,
  a.session_id,
  a.stage_id,
  a.stage_slug,
  a.version,
  a.feedback_text,
  a.created_at
from public.session_artifacts a
where a.feedback_text is not null;

alter table public.session_artifacts
  drop column feedback_text;

create or replace function internal.enforce_session_artifact_feedback_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.sessions', new.session_id, 'session_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.pipeline_stages', new.stage_id, 'stage_id');
  return new;
end;
$$;

create trigger session_artifact_feedback_enforce_refs
before insert or update on public.session_artifact_feedback
for each row
execute function internal.enforce_session_artifact_feedback_refs();

alter table public.session_artifact_feedback enable row level security;

revoke all on public.session_artifact_feedback from anon, authenticated;
grant select on public.session_artifact_feedback to authenticated;

create policy session_artifact_feedback_select_membership
  on public.session_artifact_feedback
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));
