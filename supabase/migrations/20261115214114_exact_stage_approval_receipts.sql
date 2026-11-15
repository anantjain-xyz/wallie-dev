-- A stage completion records progression. Its exact approval receipt records
-- the artifact the reviewer accepted, even after rerouting invalidates completion.
create table public.session_stage_approval_receipts (
  id uuid primary key default gen_random_uuid(),
  approval_number bigint generated always as identity unique,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  completion_id uuid not null,
  stage_id uuid not null,
  artifact_id uuid not null,
  artifact_version integer not null check (artifact_version > 0),
  artifact_digest text not null check (artifact_digest ~ '^[0-9a-f]{64}$'),
  approved_by_member_id uuid not null,
  approved_at timestamptz not null default clock_timestamp()
);
create index session_stage_approval_receipts_completion_idx
  on public.session_stage_approval_receipts(completion_id, approval_number desc);
create index session_stage_approval_receipts_workspace_idx on public.session_stage_approval_receipts(workspace_id);
create index session_stage_approval_receipts_session_idx on public.session_stage_approval_receipts(session_id);

alter table public.session_stage_approval_receipts enable row level security;
revoke all on public.session_stage_approval_receipts from public, anon, authenticated, service_role;
grant select on public.session_stage_approval_receipts to service_role;

create function internal.preserve_stage_approval_receipt()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.workspaces where id = old.workspace_id)
    or not exists (select 1 from public.sessions where id = old.session_id)
  ) then return old; end if;
  raise exception 'Stage approval receipts are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_stage_approval_receipt() from public, anon, authenticated, service_role;
create trigger preserve_stage_approval_receipt before update or delete on public.session_stage_approval_receipts
  for each row execute function internal.preserve_stage_approval_receipt();

-- Markdown uses its exact UTF-8 bytes. Older JSON-shaped artifacts use
-- PostgreSQL's JSONB text representation when approved through this path.
create function internal.approved_predecessor_artifact_text(p_artifact jsonb)
returns text language sql immutable strict security invoker set search_path = '' as $$
  select case when jsonb_typeof(p_artifact) = 'string' then p_artifact #>> '{}' else p_artifact::text end;
$$;
revoke all on function internal.approved_predecessor_artifact_text(jsonb) from public, anon, authenticated, service_role;

-- Reuse the current approval, budget, and enqueue transaction. The wrapper
-- stores a receipt only if that transaction returned a successful transition.
alter function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint) set schema internal;
alter function internal.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)
  rename to approve_session_stage_before_receipts;
revoke all on function internal.approve_session_stage_before_receipts(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)
  from public, anon, authenticated, service_role;

create function public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid,
  expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text,
  p_agent_model_name text, p_run_type text default 'project', p_expected_review_revision bigint default null)
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,phase_status public.pipeline_phase_status,
  workspace_id uuid,linear_issue_url text,archived_at timestamptz,current_artifact_version integer,rejection_count integer,
  job_id uuid,run_id uuid,job_created boolean)
language plpgsql security definer set search_path = '' as $$
declare completion uuid; reviewed_text text;
begin
  return query select * from internal.approve_session_stage_before_receipts(target_session_id, expected_workspace_id,
    expected_stage_id, expected_artifact_id, expected_version, approver_member_id, p_agent_model_provider,
    p_agent_model_name, p_run_type, p_expected_review_revision);
  if not found then return; end if;

  select c.id into strict completion from public.session_phase_completions c
  where (c.workspace_id, c.session_id, c.stage_id) = (expected_workspace_id, target_session_id, expected_stage_id)
  order by c.completed_at desc, c.id desc limit 1;
  select internal.approved_predecessor_artifact_text(a.artifact_json) into strict reviewed_text
  from public.session_artifacts a
  where (a.workspace_id, a.session_id, a.stage_id, a.id, a.version) =
    (expected_workspace_id, target_session_id, expected_stage_id, expected_artifact_id, expected_version);
  insert into public.session_stage_approval_receipts (
    workspace_id, session_id, completion_id, stage_id, artifact_id, artifact_version, artifact_digest, approved_by_member_id
  ) values (expected_workspace_id, target_session_id, completion, expected_stage_id, expected_artifact_id, expected_version,
    encode(sha256(convert_to(reviewed_text, 'UTF8')), 'hex'), approver_member_id);
end;
$$;
revoke all on function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint) to service_role;

-- Select from still-valid completions and only join the exact artifact bound by
-- their newest approval. Workers handle older completions as unverified inputs.
create function public.load_attempt_predecessor_approvals(p_session_id uuid)
returns table(completion_id uuid, stage_id uuid, stage_slug text, current_stage_slug text,
  approval_receipt_id uuid, artifact_id uuid, artifact_version integer, artifact_digest text, artifact_text text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.stage_id, c.stage_slug, stage.slug, approval.id, approval.artifact_id, approval.artifact_version,
    approval.artifact_digest, internal.approved_predecessor_artifact_text(a.artifact_json)
  from public.sessions owner
  join public.session_phase_completions c on (c.workspace_id, c.session_id) = (owner.workspace_id, owner.id)
  left join public.pipeline_stages stage on (stage.workspace_id, stage.pipeline_id, stage.id) =
    (owner.workspace_id, owner.pipeline_id, c.stage_id)
  left join lateral (
    select receipt.* from public.session_stage_approval_receipts receipt
    where (receipt.workspace_id, receipt.session_id, receipt.completion_id, receipt.stage_id) =
      (c.workspace_id, c.session_id, c.id, c.stage_id)
    order by receipt.approval_number desc limit 1
  ) approval on true
  left join public.session_artifacts a on (a.workspace_id, a.session_id, a.stage_id, a.id, a.version) =
    (approval.workspace_id, approval.session_id, approval.stage_id, approval.artifact_id, approval.artifact_version)
  where owner.id = p_session_id and c.stage_id is distinct from owner.current_stage_id
  order by stage.position nulls last, approval.approval_number desc nulls last, c.completed_at desc, c.id desc;
$$;
revoke all on function public.load_attempt_predecessor_approvals(uuid) from public, anon, authenticated, service_role;
grant execute on function public.load_attempt_predecessor_approvals(uuid) to service_role;
