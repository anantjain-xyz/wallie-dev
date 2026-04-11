-- Atomic approval RPC: collapses the three sequential UPDATEs in
-- handleApproval (CAS, set timestamp, advance phase) into a single
-- transactional function. This eliminates the failure window where the CAS
-- succeeds but a follow-up UPDATE crashes — leaving the row in `approved`
-- without a timestamp or without phase advancement.

create or replace function public.approve_pipeline_phase(
  pipeline_issue_id uuid,
  expected_workspace_id uuid,
  expected_version integer
)
returns table (
  id uuid,
  phase public.pipeline_phase,
  phase_status public.pipeline_phase_status,
  workspace_id uuid,
  slack_channel_id text,
  slack_thread_ts text,
  linear_issue_url text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_phase public.pipeline_phase;
  next_phase public.pipeline_phase;
  ts_field text;
  approved_at_now timestamptz := now();
  is_terminal boolean := false;
begin
  -- CAS guard: only proceed if the row is in awaiting_review at the expected
  -- version AND belongs to the expected workspace. This is the same gate the
  -- caller used to do as a separate UPDATE — pulling it inside the function
  -- closes the race window between the CAS and subsequent writes.
  update public.pipeline_issues pi
  set phase_status = 'approved'
  where pi.id = pipeline_issue_id
    and pi.workspace_id = expected_workspace_id
    and pi.current_artifact_version = expected_version
    and pi.phase_status = 'awaiting_review'
  returning pi.phase into current_phase;

  if current_phase is null then
    return;
  end if;

  -- Approval timestamp per phase. Mirrors approvalTimestampField() in
  -- src/lib/pipeline/state-machine.ts so the wallie-cc app and the database
  -- agree on which column tracks each phase's approval time.
  ts_field := case current_phase
    when 'product' then 'product_approved_at'
    when 'design' then 'design_approved_at'
    when 'engineering' then 'engineering_approved_at'
    else null
  end;

  if ts_field is not null then
    execute format(
      'update public.pipeline_issues set %I = $1 where id = $2',
      ts_field
    ) using approved_at_now, pipeline_issue_id;
  end if;

  -- Terminal engineering → shipped advancement. Mirrors nextPhase() in
  -- src/lib/pipeline/state-machine.ts. Intermediate phases stay at
  -- (current_phase, approved) until a future agent worker promotes them.
  next_phase := case current_phase
    when 'product' then 'design'::public.pipeline_phase
    when 'design' then 'engineering'::public.pipeline_phase
    when 'engineering' then 'shipped'::public.pipeline_phase
    else null
  end;

  if next_phase = 'shipped' then
    update public.pipeline_issues
    set phase = 'shipped',
        phase_status = 'approved',
        shipped_at = approved_at_now
    where id = pipeline_issue_id;
    is_terminal := true;
  end if;

  return query
    select
      pi.id,
      pi.phase,
      pi.phase_status,
      pi.workspace_id,
      pi.slack_channel_id,
      pi.slack_thread_ts,
      pi.linear_issue_url
    from public.pipeline_issues pi
    where pi.id = pipeline_issue_id;
end;
$$;

revoke all on function public.approve_pipeline_phase(uuid, uuid, integer) from public;
grant execute on function public.approve_pipeline_phase(uuid, uuid, integer) to service_role;
