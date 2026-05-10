-- Rewrite the default pipeline atomically from the settings editor. The
-- route handler calls this RPC once; any unexpected write failure aborts the
-- function transaction and leaves the pipeline unchanged.

alter table public.pipeline_stages
  drop constraint pipeline_stages_pipeline_slug_unique,
  add constraint pipeline_stages_pipeline_slug_unique
    unique (pipeline_id, slug)
    deferrable initially deferred;

alter table public.pipeline_stages
  drop constraint pipeline_stages_pipeline_position_unique,
  add constraint pipeline_stages_pipeline_position_unique
    unique (pipeline_id, position)
    deferrable initially deferred;

create or replace function public.rewrite_default_pipeline(
  target_workspace_id uuid,
  pipeline_name text,
  stage_payload jsonb
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

  create temporary table if not exists pipeline_rewrite_stages (
    input_index integer primary key,
    id uuid,
    slug text not null,
    name text not null,
    description text not null,
    prompt_template_md text not null,
    approver_member_ids uuid[] not null
  ) on commit drop;

  truncate table pg_temp.pipeline_rewrite_stages;

  insert into pg_temp.pipeline_rewrite_stages (
    input_index,
    id,
    slug,
    name,
    description,
    prompt_template_md,
    approver_member_ids
  )
  select
    payload.ordinality::integer,
    nullif(payload.stage ->> 'id', '')::uuid,
    payload.stage ->> 'slug',
    payload.stage ->> 'name',
    coalesce(payload.stage ->> 'description', ''),
    coalesce(payload.stage ->> 'promptTemplateMd', ''),
    array(
      select ids.member_id::uuid
      from jsonb_array_elements_text(
        coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
      ) with ordinality as ids(member_id, member_ordinality)
      order by ids.member_ordinality
    )::uuid[]
  from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality);

  select coalesce(array_agg(duplicate_ids.id order by duplicate_ids.id), '{}'::uuid[])
  into duplicate_stage_ids
  from (
    select i.id
    from pg_temp.pipeline_rewrite_stages i
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

  select coalesce(array_agg(duplicate_slugs.slug order by duplicate_slugs.slug), '{}'::text[])
  into duplicate_stage_slugs
  from (
    select i.slug
    from pg_temp.pipeline_rewrite_stages i
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

  select coalesce(array_agg(distinct ids.member_id order by ids.member_id), '{}'::uuid[])
  into invalid_member_ids
  from (
    select unnest(i.approver_member_ids) as member_id
    from pg_temp.pipeline_rewrite_stages i
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

  select coalesce(array_agg(ps.id order by ps.position), '{}'::uuid[])
  into delete_stage_ids
  from public.pipeline_stages ps
  where ps.pipeline_id = target_pipeline_id
    and not exists (
      select 1
      from pg_temp.pipeline_rewrite_stages i
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
  set name = coalesce(pipeline_name, 'Default')
  where p.id = target_pipeline_id;

  update public.pipeline_stages ps
  set
    approver_member_ids = i.approver_member_ids,
    description = i.description,
    name = i.name,
    position = i.input_index,
    prompt_template_md = i.prompt_template_md,
    slug = i.slug
  from pg_temp.pipeline_rewrite_stages i
  where ps.id = i.id
    and ps.pipeline_id = target_pipeline_id;

  insert into public.pipeline_stages (
    pipeline_id,
    workspace_id,
    position,
    slug,
    name,
    description,
    prompt_template_md,
    approver_member_ids
  )
  select
    target_pipeline_id,
    target_workspace_id,
    i.input_index,
    i.slug,
    i.name,
    i.description,
    i.prompt_template_md,
    i.approver_member_ids
  from pg_temp.pipeline_rewrite_stages i
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

revoke all on function public.rewrite_default_pipeline(uuid, text, jsonb) from public;
grant execute on function public.rewrite_default_pipeline(uuid, text, jsonb) to service_role;
