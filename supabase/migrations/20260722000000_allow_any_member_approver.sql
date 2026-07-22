-- Allow "Anyone can approve" on pipeline stages.
--
-- Adds a boolean flag to pipeline_stages. When true, any active workspace
-- member can approve the stage, bypassing the explicit approver list and the
-- owner/admin fallback.

alter table public.pipeline_stages
  add column if not exists allow_any_member_to_approve boolean not null default false;

-- ---------------------------------------------------------------------------
-- approve_session_stage: add allow_any branch
-- ---------------------------------------------------------------------------

create or replace function public.approve_session_stage(
  target_session_id uuid,
  expected_workspace_id uuid,
  expected_version integer,
  approver_member_id uuid default null
)
returns table (
  id uuid,
  pipeline_id uuid,
  current_stage_id uuid,
  current_stage_slug text,
  phase_status public.pipeline_phase_status,
  workspace_id uuid,
  linear_issue_url text,
  archived_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  session_pipeline_id uuid;
  current_stage_id_v uuid;
  current_stage_slug_v text;
  current_position integer;
  approver_list uuid[];
  allow_any boolean;
  approver_role public.member_role;
  approver_active boolean;
  approver_workspace uuid;
  next_stage_id uuid;
  approved_at_now timestamptz := now();
begin
  select s.pipeline_id, s.current_stage_id
  into session_pipeline_id, current_stage_id_v
  from public.sessions s
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
    and s.archived_at is null;

  if current_stage_id_v is null then
    return;
  end if;

  select ps.position, ps.slug, ps.approver_member_ids, ps.allow_any_member_to_approve
  into current_position, current_stage_slug_v, approver_list, allow_any
  from public.pipeline_stages ps
  where ps.id = current_stage_id_v;

  if approver_member_id is not null then
    select wm.role, wm.is_active, wm.workspace_id
    into approver_role, approver_active, approver_workspace
    from public.workspace_members wm
    where wm.id = approver_member_id;

    if not coalesce(approver_active, false)
       or approver_workspace is distinct from expected_workspace_id then
      return;
    end if;
  end if;

  if coalesce(allow_any, false) then
    -- Anyone in the workspace can approve: only require active membership.
    if approver_member_id is null then
      return;
    end if;
  elsif coalesce(array_length(approver_list, 1), 0) > 0 then
    if approver_member_id is null
       or not (approver_member_id = any(approver_list)) then
      return;
    end if;
  else
    -- Empty list: fall back to workspace owner/admin.
    if approver_member_id is null
       or approver_role is null
       or approver_role not in ('owner', 'admin') then
      return;
    end if;
  end if;

  update public.sessions s
  set phase_status = 'approved'
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
    and s.archived_at is null;

  if not found then
    return;
  end if;

  insert into public.session_phase_completions (
    session_id,
    workspace_id,
    stage_id,
    stage_slug,
    completed_at,
    completed_by_member_id
  )
  values (
    target_session_id,
    expected_workspace_id,
    current_stage_id_v,
    current_stage_slug_v,
    approved_at_now,
    approver_member_id
  )
  on conflict (session_id, stage_slug) do nothing;

  select ps.id into next_stage_id
  from public.pipeline_stages ps
  where ps.pipeline_id = session_pipeline_id
    and ps.position > current_position
  order by ps.position asc
  limit 1;

  if next_stage_id is null then
    update public.sessions s
    set archived_at = approved_at_now
    where s.id = target_session_id;
  else
    update public.sessions s
    set current_stage_id = next_stage_id,
        phase_status = 'agent_generating',
        current_artifact_version = 0,
        rejection_count = 0
    where s.id = target_session_id;
  end if;

  return query
    select
      s.id,
      s.pipeline_id,
      s.current_stage_id,
      ps.slug,
      s.phase_status,
      s.workspace_id,
      s.linear_issue_url,
      s.archived_at
    from public.sessions s
    join public.pipeline_stages ps on ps.id = s.current_stage_id
    where s.id = target_session_id;
end;
$$;

revoke all on function public.approve_session_stage(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_session_stage(uuid, uuid, integer, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- rewrite_default_pipeline: accept and persist allow_any_member_to_approve
-- ---------------------------------------------------------------------------

drop function if exists public.rewrite_default_pipeline(uuid, text, jsonb);
drop function if exists public.rewrite_default_pipeline(uuid, text, jsonb, text);

create function public.rewrite_default_pipeline(
  target_workspace_id uuid,
  pipeline_name text,
  stage_payload jsonb,
  operating_rules_md text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pipeline_id uuid;
  duplicate_stage_ids uuid[];
  duplicate_stage_slugs text[];
  invalid_member_ids uuid[];
  delete_stage_ids uuid[];
  blocking_session_numbers integer[];
begin
  if coalesce(jsonb_typeof(stage_payload), '') <> 'array'
     or jsonb_array_length(stage_payload) = 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'invalid_stage_payload'
    );
  end if;

  select p.id
  into target_pipeline_id
  from public.pipelines p
  where p.workspace_id = target_workspace_id
    and p.is_default = true
  for update;

  if target_pipeline_id is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'pipeline_not_found'
    );
  end if;

  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug,
      payload.stage ->> 'name' as name,
      coalesce(payload.stage ->> 'description', '') as description,
      coalesce(payload.stage ->> 'promptTemplateMd', '') as prompt_template_md,
      array(
        select ids.member_id::uuid
        from jsonb_array_elements_text(
          coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
        ) with ordinality as ids(member_id, member_ordinality)
        order by ids.member_ordinality
      )::uuid[] as approver_member_ids,
      coalesce((payload.stage ->> 'allowAnyMemberToApprove')::boolean, false) as allow_any_member_to_approve
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(duplicate_ids.id order by duplicate_ids.id), '{}'::uuid[])
  into duplicate_stage_ids
  from (
    select i.id
    from input_stages i
    where i.id is not null
    group by i.id
    having count(*) > 1
  ) duplicate_ids;

  if cardinality(duplicate_stage_ids) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'duplicate_stage_id',
      'duplicate_stage_ids', to_jsonb(duplicate_stage_ids)
    );
  end if;

  with input_stages as (
    select payload.stage ->> 'slug' as slug
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(duplicate_slugs.slug order by duplicate_slugs.slug), '{}'::text[])
  into duplicate_stage_slugs
  from (
    select i.slug
    from input_stages i
    group by i.slug
    having count(*) > 1
  ) duplicate_slugs;

  if cardinality(duplicate_stage_slugs) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'duplicate_stage_slug',
      'duplicate_stage_slugs', to_jsonb(duplicate_stage_slugs)
    );
  end if;

  with input_stages as (
    select array(
      select ids.member_id::uuid
      from jsonb_array_elements_text(
        coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
      ) with ordinality as ids(member_id, member_ordinality)
      order by ids.member_ordinality
    )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(distinct ids.member_id order by ids.member_id), '{}'::uuid[])
  into invalid_member_ids
  from (
    select unnest(i.approver_member_ids) as member_id
    from input_stages i
  ) ids
  where not exists (
    select 1
    from public.workspace_members wm
    where wm.id = ids.member_id
      and wm.workspace_id = target_workspace_id
  );

  if cardinality(invalid_member_ids) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'unknown_approver_member_ids',
      'invalid_approver_member_ids', to_jsonb(invalid_member_ids)
    );
  end if;

  with input_stages as (
    select nullif(payload.stage ->> 'id', '')::uuid as id
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(ps.id order by ps.position), '{}'::uuid[])
  into delete_stage_ids
  from public.pipeline_stages ps
  where ps.pipeline_id = target_pipeline_id
    and not exists (
      select 1
      from input_stages i
      where i.id = ps.id
    );

  select coalesce(array_agg(s.number order by s.number), '{}'::integer[])
  into blocking_session_numbers
  from public.sessions s
  where s.workspace_id = target_workspace_id
    and s.archived_at is null
    and s.current_stage_id = any(delete_stage_ids);

  if cardinality(blocking_session_numbers) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'stage_delete_blocked',
      'blocking_session_numbers', to_jsonb(blocking_session_numbers)
    );
  end if;

  set constraints
    public.pipeline_stages_pipeline_slug_unique,
    public.pipeline_stages_pipeline_position_unique
    deferred;

  update public.pipelines p
  set
    name = coalesce(pipeline_name, 'Default'),
    operating_rules_md = coalesce(
      rewrite_default_pipeline.operating_rules_md,
      p.operating_rules_md
    )
  where p.id = target_pipeline_id;

  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug,
      payload.stage ->> 'name' as name,
      coalesce(payload.stage ->> 'description', '') as description,
      coalesce(payload.stage ->> 'promptTemplateMd', '') as prompt_template_md,
      array(
        select ids.member_id::uuid
        from jsonb_array_elements_text(
          coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
        ) with ordinality as ids(member_id, member_ordinality)
        order by ids.member_ordinality
      )::uuid[] as approver_member_ids,
      coalesce((payload.stage ->> 'allowAnyMemberToApprove')::boolean, false) as allow_any_member_to_approve
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  update public.pipeline_stages ps
  set
    allow_any_member_to_approve = i.allow_any_member_to_approve,
    approver_member_ids = i.approver_member_ids,
    description = i.description,
    name = i.name,
    position = i.input_index,
    prompt_template_md = i.prompt_template_md,
    slug = i.slug
  from input_stages i
  where ps.id = i.id
    and ps.pipeline_id = target_pipeline_id;

  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug,
      payload.stage ->> 'name' as name,
      coalesce(payload.stage ->> 'description', '') as description,
      coalesce(payload.stage ->> 'promptTemplateMd', '') as prompt_template_md,
      array(
        select ids.member_id::uuid
        from jsonb_array_elements_text(
          coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
        ) with ordinality as ids(member_id, member_ordinality)
        order by ids.member_ordinality
      )::uuid[] as approver_member_ids,
      coalesce((payload.stage ->> 'allowAnyMemberToApprove')::boolean, false) as allow_any_member_to_approve
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  insert into public.pipeline_stages (
    pipeline_id,
    workspace_id,
    position,
    slug,
    name,
    description,
    prompt_template_md,
    approver_member_ids,
    allow_any_member_to_approve
  )
  select
    target_pipeline_id,
    target_workspace_id,
    i.input_index,
    i.slug,
    i.name,
    i.description,
    i.prompt_template_md,
    i.approver_member_ids,
    i.allow_any_member_to_approve
  from input_stages i
  where i.id is null
    or not exists (
      select 1
      from public.pipeline_stages ps
      where ps.id = i.id
        and ps.pipeline_id = target_pipeline_id
    );

  delete from public.pipeline_stages ps
  where ps.pipeline_id = target_pipeline_id
    and ps.id = any(delete_stage_ids);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.rewrite_default_pipeline(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.rewrite_default_pipeline(uuid, text, jsonb, text)
  to service_role;
