-- Stage assignments require active human approvers and serialize with removal.
create or replace function public.rewrite_default_pipeline(
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
  archived_stage_slug_conflicts text[];
  invalid_member_ids uuid[];
  existing_stage_count integer;
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
    select nullif(payload.stage ->> 'id', '')::uuid as id
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

  -- Archived slugs remain reserved because artifacts and prompt variables use
  -- slug snapshots. The archived row must be restored rather than duplicated.
  with input_stages as (
    select
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(distinct ps.slug order by ps.slug), '{}'::text[])
  into archived_stage_slug_conflicts
  from public.pipeline_stages ps
  join input_stages i on i.slug = ps.slug
  where ps.pipeline_id = target_pipeline_id
    and i.id is distinct from ps.id
    -- A submitted durable row may release its old slug in the same rewrite
    -- (for example an atomic slug swap). Every other existing owner is either
    -- already archived or will be archived by this payload and must be restored.
    and not exists (
      select 1
      from input_stages owner
      where owner.id = ps.id
        and owner.slug is distinct from ps.slug
    );

  if cardinality(archived_stage_slug_conflicts) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'archived_stage_slug_conflict',
      'archived_stage_slugs', to_jsonb(archived_stage_slug_conflicts)
    );
  end if;

  -- Lock referenced membership rows until the stage rewrite commits. Member
  -- removal takes pipeline locks first, matching this pipeline -> member order.
  perform wm.id
  from public.workspace_members wm
  where wm.workspace_id = target_workspace_id
    and wm.id in (
      select ids.member_id::uuid
      from jsonb_array_elements(stage_payload) payload(stage)
      cross join lateral jsonb_array_elements_text(
        coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
      ) ids(member_id)
    )
  order by wm.id
  for share;

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
      and wm.kind = 'human'
      and wm.is_active
  );

  if cardinality(invalid_member_ids) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'unknown_approver_member_ids',
      'invalid_approver_member_ids', to_jsonb(invalid_member_ids)
    );
  end if;

  select count(*)::integer
  into existing_stage_count
  from public.pipeline_stages ps
  where ps.pipeline_id = target_pipeline_id;

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

  -- Archive every omitted row, preserving its original timestamp and position.
  with input_stages as (
    select nullif(payload.stage ->> 'id', '')::uuid as id
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  update public.pipeline_stages ps
  set archived_at = coalesce(ps.archived_at, statement_timestamp())
  where ps.pipeline_id = target_pipeline_id
    and not exists (
      select 1
      from input_stages i
      where i.id = ps.id
    );

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
      )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  update public.pipeline_stages ps
  set
    approver_member_ids = i.approver_member_ids,
    archived_at = null,
    description = i.description,
    name = i.name,
    prompt_template_md = i.prompt_template_md,
    slug = i.slug
  from input_stages i
  where ps.id = i.id
    and ps.pipeline_id = target_pipeline_id;

  -- New stages start beyond the old range and receive their final slot below.
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
      )::uuid[] as approver_member_ids
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
    archived_at
  )
  select
    target_pipeline_id,
    target_workspace_id,
    existing_stage_count + i.input_index,
    i.slug,
    i.name,
    i.description,
    i.prompt_template_md,
    i.approver_member_ids,
    null
  from input_stages i
  where i.id is null
    or not exists (
      select 1
      from public.pipeline_stages ps
      where ps.id = i.id
        and ps.pipeline_id = target_pipeline_id
    );

  -- Fill every non-reserved position with active rows in payload order.
  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  ),
  active_rows as (
    select ps.id, i.input_index
    from input_stages i
    join public.pipeline_stages ps
      on ps.pipeline_id = target_pipeline_id
     and ps.archived_at is null
     and (
       ps.id = i.id
       or (
         (i.id is null or not exists (
           select 1
           from public.pipeline_stages known
           where known.id = i.id
             and known.pipeline_id = target_pipeline_id
         ))
         and ps.slug = i.slug
       )
     )
  ),
  available_slots as (
    select
      slot.position,
      row_number() over (order by slot.position)::integer as input_index
    from generate_series(
      1,
      (select count(*)::integer from public.pipeline_stages where pipeline_id = target_pipeline_id)
    ) as slot(position)
    where not exists (
      select 1
      from public.pipeline_stages archived
      where archived.pipeline_id = target_pipeline_id
        and archived.archived_at is not null
        and archived.position = slot.position
    )
  )
  update public.pipeline_stages ps
  set position = slots.position
  from active_rows active
  join available_slots slots on slots.input_index = active.input_index
  where ps.id = active.id;

  -- Linear routes are stored by slug rather than stage id. If an archived
  -- stage was a route target, move that route to the nearest surviving stage,
  -- preferring the previous stage when candidates are equally distant. This
  -- keeps the routing update atomic with archival and preserves unaffected
  -- route targets.
  update public.workspace_linear_routing routing
  set rework_stage_slug = coalesce(
    (
      select candidate.slug
      from public.pipeline_stages candidate
      left join public.pipeline_stages referenced
        on referenced.pipeline_id = target_pipeline_id
       and referenced.slug = routing.rework_stage_slug
      where candidate.pipeline_id = target_pipeline_id
        and candidate.archived_at is null
      order by
        abs(candidate.position - coalesce(referenced.position, candidate.position)),
        case when candidate.position < referenced.position then 0 else 1 end,
        candidate.position
      limit 1
    ),
    routing.rework_stage_slug
  )
  where routing.workspace_id = target_workspace_id
    and not exists (
      select 1
      from public.pipeline_stages active
      where active.pipeline_id = target_pipeline_id
        and active.archived_at is null
        and active.slug = routing.rework_stage_slug
    );

  update public.workspace_linear_routing routing
  set land_stage_slug = coalesce(
    (
      select candidate.slug
      from public.pipeline_stages candidate
      left join public.pipeline_stages referenced
        on referenced.pipeline_id = target_pipeline_id
       and referenced.slug = routing.land_stage_slug
      where candidate.pipeline_id = target_pipeline_id
        and candidate.archived_at is null
      order by
        abs(candidate.position - coalesce(referenced.position, candidate.position)),
        case when candidate.position < referenced.position then 0 else 1 end,
        candidate.position
      limit 1
    ),
    routing.land_stage_slug
  )
  where routing.workspace_id = target_workspace_id
    and not exists (
      select 1
      from public.pipeline_stages active
      where active.pipeline_id = target_pipeline_id
        and active.archived_at is null
        and active.slug = routing.land_stage_slug
    );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.rewrite_default_pipeline(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.rewrite_default_pipeline(uuid, text, jsonb, text)
  to service_role;

create or replace function public.remove_workspace_member(
  target_member_id uuid,
  expected_workspace_id uuid
)
returns table (
  id uuid,
  full_name text,
  email text,
  role public.member_role
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed_id uuid;
  removed_full_name text;
  removed_email text;
  removed_role public.member_role;
begin
  -- Serialize pruning with pipeline rewrites before changing membership. An
  -- editor that read an earlier member list must revalidate after this lock.
  perform pipeline.id from public.pipelines pipeline
  where pipeline.workspace_id = expected_workspace_id
  order by pipeline.id
  for update;

  update public.workspace_members wm
  set is_active = false
  where wm.id = target_member_id
    and wm.workspace_id = expected_workspace_id
    and wm.kind = 'human'
    and wm.is_active = true
    and wm.role <> 'owner'
  returning wm.id, wm.full_name, wm.email, wm.role
  into removed_id, removed_full_name, removed_email, removed_role;

  if removed_id is null then
    return;
  end if;

  update public.pipeline_stages ps
  set approver_member_ids = array_remove(ps.approver_member_ids, target_member_id)
  where ps.workspace_id = expected_workspace_id
    and target_member_id = any(ps.approver_member_ids);

  return query
    select removed_id, removed_full_name, removed_email, removed_role;
end;
$$;

revoke all on function public.remove_workspace_member(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.remove_workspace_member(uuid, uuid)
  to service_role;

-- Prune invalid historical approvers so old stages regain the existing empty
-- list policy. Keep active human member order and stage identities unchanged.
update public.pipeline_stages stage
set approver_member_ids = array(
  select member_id
  from unnest(stage.approver_member_ids) with ordinality selected(member_id, position)
  where exists (
    select 1 from public.workspace_members member
    where member.id = selected.member_id
      and member.workspace_id = stage.workspace_id
      and member.kind = 'human' and member.is_active
  )
  order by position
)
where exists (
  select 1 from unnest(stage.approver_member_ids) selected(member_id)
  where not exists (
    select 1 from public.workspace_members member
    where member.id = selected.member_id
      and member.workspace_id = stage.workspace_id
      and member.kind = 'human' and member.is_active
  )
);
