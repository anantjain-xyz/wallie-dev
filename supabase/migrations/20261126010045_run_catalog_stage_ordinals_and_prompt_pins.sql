drop function public.list_workspace_run_catalog(uuid, timestamptz, uuid, uuid, public.agent_run_status, text, uuid, uuid, integer, uuid);

create function public.list_workspace_run_catalog(
  p_workspace_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_session_id uuid default null,
  p_status public.agent_run_status default null,
  p_provider text default null,
  p_stage_id uuid default null,
  p_run_id uuid default null,
  p_limit integer default 20,
  p_factory_id uuid default null,
  p_agent_id uuid default null,
  p_agent_prompt_revision_id uuid default null
) returns table (
  run_id uuid,
  session_id uuid,
  session_number integer,
  session_title text,
  job_id uuid,
  attempt_count integer,
  stage_id uuid,
  stage_name text,
  model_provider text,
  model_name text,
  status public.agent_run_status,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_activity_at timestamptz,
  source_recovery_required boolean,
  has_events boolean,
  capture_ended boolean,
  capture_interrupted boolean,
  failure_receipt text,
  input_tokens bigint,
  output_tokens bigint,
  total_cost_usd numeric,
  token_provenance text,
  cost_provenance text,
  usage_finalized_at timestamptz,
  transcript_expired_at timestamptz,
  factory_id uuid,
  stage_ordinal integer,
  newer_run_id uuid
) language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
begin
  if not exists(select 1 from public.workspaces w
    where w.id = p_workspace_id and w.deletion_requested_at is null) then
    raise exception 'Run catalog workspace is unavailable.' using errcode = 'P0002';
  end if;
  -- RLS applies independently to runs, sessions, messages and events. The
  -- bounded page is selected before any per-run transcript metadata lookup.
  return query
  with page as materialized (
    select r.id, r.session_id, s.number, left(s.title, 200) as title,
      r.agent_job_id, r.attempt_count, r.stage_id, left(r.stage_name, 128) as stage_name,
      left(r.model_provider, 64) as model_provider, left(r.model_name, 128) as model_name,
      r.status, r.created_at, r.started_at, r.finished_at, r.last_activity_at,
      r.source_recovery_required, r.input_tokens, r.output_tokens, r.total_cost_usd,
      r.token_provenance, r.cost_provenance, r.usage_finalized_at, s.factory_id
    from public.agent_runs r
    join public.sessions s on s.id = r.session_id and s.workspace_id = r.workspace_id
    where r.workspace_id = p_workspace_id
      and (p_factory_id is null or s.factory_id = p_factory_id)
      and (p_session_id is null or r.session_id = p_session_id)
      and (p_status is null or r.status = p_status)
      and (p_provider is null or r.model_provider = p_provider)
      and (p_stage_id is null or r.stage_id = p_stage_id)
      and (p_run_id is null or r.id = p_run_id)
      and (
        (p_agent_id is null and p_agent_prompt_revision_id is null)
        -- Legacy rows can have a synthetic default pin. Only a revision that
        -- existed at creation on a versioned execution is attributable here.
        or (
          r.agent_id = p_agent_id and r.agent_prompt_revision_id = p_agent_prompt_revision_id
          and s.execute_pinned_definition
          and exists (
            select 1 from public.factory_agent_prompt_revisions prompt
            where (prompt.workspace_id, prompt.factory_id, prompt.agent_id, prompt.id) =
              (r.workspace_id, s.factory_id, r.agent_id, r.agent_prompt_revision_id)
              and prompt.created_at <= r.created_at
          )
          and exists (
            select 1 from public.factory_definition_revisions definition
            where (definition.workspace_id, definition.factory_id, definition.id) =
              (s.workspace_id, s.factory_id, s.factory_definition_revision_id)
              and definition.definition_json::jsonb ? 'implementationAgent'
          )
        )
      )
      and ((p_before_created_at is null and p_before_id is null)
        or (p_before_created_at is not null and p_before_id is not null
          and (r.created_at, r.id) < (p_before_created_at, p_before_id)))
    order by r.created_at desc, r.id desc
    limit least(greatest(coalesce(p_limit, 20), 1), 51)
  )
  select p.id, p.session_id, p.number, p.title, p.agent_job_id, p.attempt_count,
    p.stage_id, p.stage_name, p.model_provider, p.model_name, p.status,
    p.created_at, p.started_at, p.finished_at, p.last_activity_at, p.source_recovery_required,
    event_presence.present is true,
    capture_end.sequence is not null,
    coalesce(capture_end.status = 'interrupted', false),
    case when receipt.value->'version' = '1'::jsonb
      and (receipt.value->>'category', receipt.value->>'code') in (
        ('configuration', 'credentials'), ('configuration', 'sandbox_configuration'),
        ('configuration', 'repository_configuration'), ('configuration', 'agent_configuration'),
        ('agent_exit', 'agent_exit'), ('agent_exit', 'agent_incomplete'),
        ('timeout', 'timeout'), ('budget', 'budget'), ('publication', 'publication'), ('unknown', 'unknown'))
      then jsonb_build_object('version', 1, 'category', receipt.value->>'category',
        'code', receipt.value->>'code')::text
      else null end,
    p.input_tokens, p.output_tokens, p.total_cost_usd,
    p.token_provenance, p.cost_provenance, p.usage_finalized_at, expiry.expired_at,
    p.factory_id, stage_history.ordinal, newer.id
  from page p
  cross join lateral (
    select count(*)::integer as ordinal
    from public.agent_runs prior
    where prior.workspace_id = p_workspace_id and prior.session_id = p.session_id
      and prior.stage_id is not distinct from p.stage_id
      and (prior.created_at, prior.id) <= (p.created_at, p.id)
  ) stage_history
  left join lateral (
    select later.id
    from public.agent_runs later
    where p.status in ('error', 'canceled') and later.workspace_id = p_workspace_id
      and later.session_id = p.session_id and later.stage_id is not distinct from p.stage_id
      and (later.created_at, later.id) > (p.created_at, p.id)
    order by later.created_at, later.id
    limit 1
  ) newer on true
  left join public.agent_run_transcript_expirations expiry
    on expiry.run_id = p.id and expiry.workspace_id = p_workspace_id
  left join lateral (
    select true as present from public.agent_run_events e
    where e.agent_run_id = p.id and e.workspace_id = p_workspace_id
      and e.attempt_count = p.attempt_count
    limit 1
  ) event_presence on true
  left join lateral (
    select e.sequence, e.payload->>'status' as status
    from public.agent_run_events e
    where e.agent_run_id = p.id and e.workspace_id = p_workspace_id
      and e.attempt_count = p.attempt_count and e.kind = 'capture_end'
    order by e.sequence desc limit 1
  ) capture_end on true
  left join lateral (
    select case when octet_length(m.message_md) <= 512 then
      case when m.message_md is json object then m.message_md::jsonb else null end
      else null end as value
    from public.agent_run_messages m
    where m.agent_run_id = p.id and m.workspace_id = p_workspace_id and m.kind = 'run_failure'
    limit 1
  ) receipt on true
  order by p.created_at desc, p.id desc;
end;
$$;

revoke all on function public.list_workspace_run_catalog(uuid, timestamptz, uuid, uuid, public.agent_run_status, text, uuid, uuid, integer, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_run_catalog(uuid, timestamptz, uuid, uuid, public.agent_run_status, text, uuid, uuid, integer, uuid, uuid, uuid)
  to authenticated;

comment on function public.list_workspace_run_catalog(uuid, timestamptz, uuid, uuid, public.agent_run_status, text, uuid, uuid, integer, uuid, uuid, uuid)
  is 'Scoped run metadata only, at most 51 rows. Preserve timestamp precision in the descending created_at/id cursor; refresh the head for concurrent appends.';
