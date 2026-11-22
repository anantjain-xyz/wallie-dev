alter table internal.factory_failure_cohorts
  add unique (workspace_id, factory_id, id);
alter table internal.factory_failure_cohort_members
  add unique (workspace_id, factory_id, cohort_id, id);
create index factory_failure_cohort_members_definition_idx
  on internal.factory_failure_cohort_members (workspace_id, factory_id, definition_revision_id, cohort_id, id);

create table internal.factory_failure_cohort_reviews (
  workspace_id uuid not null,
  factory_id uuid not null,
  cohort_id uuid not null,
  revision integer not null check (revision > 0),
  request_id uuid not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  actor_member_id uuid not null,
  action text not null check (action in ('label', 'dismiss', 'split')),
  disposition text not null check ((action, disposition) in (('label', 'open'), ('dismiss', 'dismissed'), ('split', 'split'))),
  label text check (char_length(label) between 1 and 120 and label = btrim(label, E' \t\r\n')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, cohort_id, revision),
  unique (workspace_id, factory_id, cohort_id, request_id),
  foreign key (workspace_id, factory_id, cohort_id)
    references internal.factory_failure_cohorts (workspace_id, factory_id, id) on delete cascade
);

create table internal.factory_failure_cohort_partitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  cohort_id uuid not null,
  review_revision integer not null,
  side text not null check (side in ('selected', 'remaining')),
  unique (workspace_id, factory_id, cohort_id, id),
  unique (workspace_id, factory_id, cohort_id, side),
  foreign key (workspace_id, factory_id, cohort_id, review_revision)
    references internal.factory_failure_cohort_reviews (workspace_id, factory_id, cohort_id, revision) on delete cascade
);

create table internal.factory_failure_cohort_partition_members (
  workspace_id uuid not null,
  factory_id uuid not null,
  cohort_id uuid not null,
  partition_id uuid not null,
  member_id uuid not null,
  primary key (workspace_id, factory_id, cohort_id, member_id),
  foreign key (workspace_id, factory_id, cohort_id, partition_id)
    references internal.factory_failure_cohort_partitions (workspace_id, factory_id, cohort_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, cohort_id, member_id)
    references internal.factory_failure_cohort_members (workspace_id, factory_id, cohort_id, id) on delete cascade
);
create index factory_failure_cohort_partition_members_page_idx
  on internal.factory_failure_cohort_partition_members (workspace_id, factory_id, cohort_id, partition_id, member_id);

alter table internal.factory_failure_cohort_reviews enable row level security;
alter table internal.factory_failure_cohort_partitions enable row level security;
alter table internal.factory_failure_cohort_partition_members enable row level security;
revoke all on internal.factory_failure_cohort_reviews, internal.factory_failure_cohort_partitions,
  internal.factory_failure_cohort_partition_members from public, anon, authenticated, service_role;

create function internal.guard_factory_failure_cohort_review()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (
      select 1 from internal.factory_failure_cohorts cohort
      where (cohort.workspace_id, cohort.factory_id, cohort.id) = (old.workspace_id, old.factory_id, old.cohort_id)
    ) then return old; end if;
    if tg_table_name = 'factory_failure_cohort_partition_members' then
      if not exists (
        select 1 from internal.factory_failure_cohort_members member
        where (member.workspace_id, member.factory_id, member.cohort_id, member.id) =
          (old.workspace_id, old.factory_id, old.cohort_id, old.member_id)
      ) then return old; end if;
    end if;
  end if;
  raise exception 'Failure cohort review history is immutable.' using errcode = '23514';
end;
$$;
create trigger factory_failure_cohort_reviews_immutable
  before update or delete on internal.factory_failure_cohort_reviews
  for each row execute function internal.guard_factory_failure_cohort_review();
create trigger factory_failure_cohort_partitions_immutable
  before update or delete on internal.factory_failure_cohort_partitions
  for each row execute function internal.guard_factory_failure_cohort_review();
create trigger factory_failure_cohort_partition_members_immutable
  before update or delete on internal.factory_failure_cohort_partition_members
  for each row execute function internal.guard_factory_failure_cohort_review();

-- A split gives each partition an address without moving or duplicating source
-- members. New receipts still belong to the original observed cohort.
create view internal.factory_failure_cohort_targets with (security_invoker = true) as
  select cohort.workspace_id, cohort.factory_id, cohort.id, cohort as source,
    null::text as partition
  from internal.factory_failure_cohorts cohort
  union all
  select partition.workspace_id, partition.factory_id, partition.id, cohort, partition.side
  from internal.factory_failure_cohort_partitions partition
  join internal.factory_failure_cohorts cohort
    on (cohort.workspace_id, cohort.factory_id, cohort.id) = (partition.workspace_id, partition.factory_id, partition.cohort_id);
revoke all on internal.factory_failure_cohort_targets from public, anon, authenticated, service_role;

create function internal.visible_factory_failure_cohort_members(
  p_cohort internal.factory_failure_cohorts, p_partition_id uuid, p_definition_revision_id uuid
) returns setof internal.factory_failure_cohort_members language sql stable set search_path = '' as $$
  select member.*
  from internal.visible_factory_failure_cohort_members(p_cohort) member
  where (p_definition_revision_id is null or member.definition_revision_id = p_definition_revision_id)
    and (p_partition_id is null or exists (
      select 1 from internal.factory_failure_cohort_partition_members partition_member
      where (partition_member.workspace_id, partition_member.factory_id, partition_member.cohort_id,
        partition_member.partition_id, partition_member.member_id) =
        (member.workspace_id, member.factory_id, member.cohort_id, p_partition_id, member.id)
    ))
$$;

create function internal.factory_failure_cohort_membership_digest(p_member_ids uuid[])
returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(array_to_string(p_member_ids, ','), ''), 'UTF8')), 'hex')
$$;

create function internal.factory_failure_cohort_review_summary(
  p_review internal.factory_failure_cohort_reviews, p_can_review boolean
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'revision', coalesce(p_review.revision, 0),
    'disposition', coalesce(p_review.disposition, 'open'),
    'label', p_review.label,
    'can_review', p_can_review and coalesce(p_review.disposition, 'open') = 'open'
  )
$$;

create function internal.factory_failure_cohort_partition_ids(
  p_cohort internal.factory_failure_cohorts, p_review_revision integer
) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(partition.id order by partition.side desc), '[]')
  from internal.factory_failure_cohort_partitions partition
  where (partition.workspace_id, partition.factory_id, partition.cohort_id, partition.review_revision) =
    (p_cohort.workspace_id, p_cohort.factory_id, p_cohort.id, p_review_revision)
    and exists (
      select 1 from internal.visible_factory_failure_cohort_members(p_cohort, partition.id, null)
    )
$$;

drop function public.list_factory_failure_cohorts(uuid, uuid, integer, uuid);
drop function public.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid);
drop function internal.list_factory_failure_cohorts(uuid, uuid, integer, uuid);
drop function internal.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid);
drop function internal.summarize_factory_failure_cohort(internal.factory_failure_cohorts);

create function internal.summarize_factory_failure_cohort(
  p_target internal.factory_failure_cohort_targets, p_review internal.factory_failure_cohort_reviews,
  p_definition_revision_id uuid, p_can_review boolean
)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  source_cohort internal.factory_failure_cohorts := p_target.source;
  support record;
  label text;
  qualification_reasons text[] := '{}';
begin
  with visible as materialized (
    select member.*, internal.factory_failure_member_evidence_state(member) as evidence_state
    from internal.visible_factory_failure_cohort_members(source_cohort,
      case when p_target.partition is not null then p_target.id end, p_definition_revision_id) member
  )
  select count(distinct run_id) as failure_count,
    count(distinct session_id) filter (where evidence_state = 'available') as support_count,
    count(distinct (definition_revision_id, execution_revision_id, agent_prompt_revision_id,
      model_provider, model_name, scorer_revision_id)) as version_count,
    bool_or(evidence_state <> 'available') as missing_evidence,
    bool_or(definition_revision_id is null or execution_revision_id is null) as missing_identity,
    min(validation_record_key) filter (where evidence_state = 'available') as available_validation_label
  into support from visible;
  if support.failure_count = 0 then return null; end if;

  if support.support_count < source_cohort.minimum_support then
    qualification_reasons := array_append(qualification_reasons, 'insufficient_support');
  end if;
  if support.version_count > 1 then
    qualification_reasons := array_append(qualification_reasons, 'mixed_versions');
  end if;
  if support.missing_evidence then
    qualification_reasons := array_append(qualification_reasons, 'missing_evidence');
  end if;
  if support.missing_identity or source_cohort.task_class_slug is null then
    qualification_reasons := array_append(qualification_reasons, 'missing_identity');
  end if;

  if source_cohort.symptom_kind = 'scorer' then
    select scorer.name into label from public.factory_scorers scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id::text) =
      (source_cohort.workspace_id, source_cohort.factory_id, source_cohort.symptom_key);
  else
    label := support.available_validation_label;
  end if;

  return jsonb_build_object(
    'id', p_target.id, 'task_class_slug', source_cohort.task_class_slug, 'agent_id', source_cohort.agent_id,
    'symptom_kind', source_cohort.symptom_kind, 'symptom_label', label,
    'failure_count', support.failure_count, 'support_count', support.support_count,
    'minimum_support', source_cohort.minimum_support, 'version_count', support.version_count,
    'qualification', case when cardinality(qualification_reasons) = 0 then 'qualified' else 'inconclusive' end,
    'qualification_reasons', qualification_reasons,
    'review', internal.factory_failure_cohort_review_summary(p_review, p_can_review and p_target.partition is null),
    'parent_cohort_id', case when p_target.partition is not null then source_cohort.id end,
    'partition', p_target.partition,
    'split_cohort_ids', internal.factory_failure_cohort_partition_ids(source_cohort, p_review.revision)
  );
end;
$$;

create function internal.latest_factory_failure_cohort_review(p_cohort internal.factory_failure_cohorts)
returns internal.factory_failure_cohort_reviews language sql stable set search_path = '' as $$
  select review
  from internal.factory_failure_cohort_reviews review
  where (review.workspace_id, review.factory_id, review.cohort_id) = (p_cohort.workspace_id, p_cohort.factory_id, p_cohort.id)
  order by review.revision desc limit 1
$$;

create function internal.list_factory_failure_cohorts(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer, p_after_cohort_id uuid,
  p_symptom_kind text, p_definition_revision_id uuid, p_disposition text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  can_review boolean;
  result jsonb;
begin
  perform internal.assert_factory_failure_cohort_read(p_workspace_id, p_factory_id, p_limit);
  if (p_symptom_kind is not null and p_symptom_kind not in ('scorer', 'validation'))
    or (p_disposition is not null and p_disposition not in ('open', 'dismissed', 'split')) then
    raise exception 'Invalid failure cohort filter.' using errcode = '22023';
  end if;

  select factory.status = 'active' and internal.can_manage_factory(factory.workspace_id, factory.id)
  into can_review from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id);

  with page as materialized (
    select target.id, target as item, review as decision
    from internal.factory_failure_cohort_targets target
    left join lateral internal.latest_factory_failure_cohort_review(target.source) review on target.partition is null
    where (target.workspace_id, target.factory_id) = (p_workspace_id, p_factory_id)
      and (p_after_cohort_id is null or target.id > p_after_cohort_id)
      and (p_symptom_kind is null or (target.source).symptom_kind = p_symptom_kind)
      and (p_disposition is null or coalesce(review.disposition, 'open') = p_disposition)
      and exists (
        select 1 from internal.visible_factory_failure_cohort_members(target.source,
          case when target.partition is not null then target.id end, p_definition_revision_id)
      )
    order by target.id limit p_limit + 1
  ),
  visible as (
    select * from page order by id limit p_limit
  )
  select jsonb_build_object(
    'cohorts', coalesce(jsonb_agg(
      internal.summarize_factory_failure_cohort(item, decision, p_definition_revision_id, can_review) order by id
    ), '[]'),
    'next_cohort_id', case when (select count(*) from page) > p_limit then
      (select id from visible order by id desc limit 1) end
  ) into result from visible;
  return result;
end;
$$;

create function internal.get_factory_failure_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_cohort_id uuid, p_limit integer,
  p_after_member_id uuid, p_definition_revision_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  target internal.factory_failure_cohort_targets;
  review internal.factory_failure_cohort_reviews;
  can_review boolean;
  partition_id uuid;
  summary jsonb;
  membership_digest text;
  result jsonb;
begin
  perform internal.assert_factory_failure_cohort_read(p_workspace_id, p_factory_id, p_limit);
  select * into target from internal.factory_failure_cohort_targets candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_cohort_id);
  if not found then raise exception 'Failure cohort is unavailable.' using errcode = 'P0002'; end if;

  select factory.status = 'active' and internal.can_manage_factory(factory.workspace_id, factory.id)
  into can_review from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id);
  if target.partition is null then
    review := internal.latest_factory_failure_cohort_review(target.source);
  else
    partition_id := target.id;
  end if;
  summary := internal.summarize_factory_failure_cohort(target, review, p_definition_revision_id, can_review);
  if summary is null then raise exception 'Failure cohort is unavailable.' using errcode = 'P0002'; end if;

  select internal.factory_failure_cohort_membership_digest(array_agg(member.id order by member.id))
  into membership_digest
  from internal.visible_factory_failure_cohort_members(target.source, partition_id, null) member;

  with page as materialized (
    select member.id, member as item
    from internal.visible_factory_failure_cohort_members(target.source, partition_id, p_definition_revision_id) member
    where p_after_member_id is null or member.id > p_after_member_id
    order by member.id limit p_limit + 1
  ),
  visible as (
    select * from page order by id limit p_limit
  )
  select jsonb_build_object(
    'cohort', summary,
    'members', coalesce(jsonb_agg(internal.project_factory_failure_cohort_member((target.source).agent_id, item) order by id), '[]'),
    'membership_digest', membership_digest,
    'next_member_id', case when (select count(*) from page) > p_limit then
      (select id from visible order by id desc limit 1) end
  ) into result from visible;
  return result;
end;
$$;

create function public.list_factory_failure_cohorts(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer default 25, p_after_cohort_id uuid default null,
  p_symptom_kind text default null, p_definition_revision_id uuid default null, p_disposition text default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.list_factory_failure_cohorts(p_workspace_id, p_factory_id, p_limit, p_after_cohort_id,
    p_symptom_kind, p_definition_revision_id, p_disposition)
$$;

create function public.get_factory_failure_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_cohort_id uuid, p_limit integer default 25,
  p_after_member_id uuid default null, p_definition_revision_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_factory_failure_cohort(p_workspace_id, p_factory_id, p_cohort_id, p_limit,
    p_after_member_id, p_definition_revision_id)
$$;

create function internal.review_factory_failure_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_cohort_id uuid, p_expected_review_revision integer,
  p_request_id uuid, p_action text, p_label text, p_selected_run_ids uuid[], p_expected_membership_digest text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  factory_status text;
  source_cohort internal.factory_failure_cohorts;
  review internal.factory_failure_cohort_reviews;
  selected_runs uuid[];
  label text := nullif(btrim(p_label, E' \t\r\n'), '');
  request_digest text;
  membership record;
  selected_cohort_id uuid;
  remaining_cohort_id uuid;
begin
  perform internal.assert_factory_failure_cohort_read(p_workspace_id, p_factory_id, 1);
  if p_expected_review_revision is null or p_expected_review_revision < 0 or p_request_id is null
    or p_action is null or p_action not in ('label', 'dismiss', 'split')
    or (p_action = 'label' and (label is null or char_length(label) > 120))
    or (p_action <> 'label' and p_label is not null)
    or (p_action <> 'split' and (p_selected_run_ids is not null or p_expected_membership_digest is not null)) then
    raise exception 'Invalid failure cohort review.' using errcode = '22023';
  end if;
  if p_action = 'split' then
    select array_agg(distinct run_id order by run_id) into selected_runs from unnest(p_selected_run_ids) chosen(run_id);
    if coalesce(cardinality(selected_runs), 0) = 0 or array_position(selected_runs, null) is not null
      or cardinality(selected_runs) <> cardinality(p_selected_run_ids)
      or p_expected_membership_digest is null or p_expected_membership_digest !~ '^[0-9a-f]{64}$' then
      raise exception 'A split requires unique run IDs and a current cohort membership digest.' using errcode = '22023';
    end if;
  end if;

  -- Match factory membership mutations: workspace, actor, then factory.
  perform 1 from public.workspaces workspace
  where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then raise exception 'Failure cohort factory is unavailable.' using errcode = 'P0002'; end if;
  select actor.id into actor_member_id from public.workspace_members actor
  where (actor.workspace_id, actor.user_id, actor.kind, actor.is_active) = (p_workspace_id, auth.uid(), 'human', true)
  for share;
  if not found then raise exception 'Failure cohort factory is unavailable.' using errcode = 'P0002'; end if;
  select factory.status into factory_status from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id) for share;
  if not found then raise exception 'Failure cohort factory is unavailable.' using errcode = 'P0002'; end if;
  if factory_status <> 'active' or not internal.can_manage_factory(p_workspace_id, p_factory_id) then
    raise exception 'An active factory manager is required to review failure cohorts.' using errcode = '42501';
  end if;

  select * into source_cohort from internal.factory_failure_cohorts candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_cohort_id)
  for no key update;
  if not found or not exists (select 1 from internal.visible_factory_failure_cohort_members(source_cohort)) then
    raise exception 'Failure cohort is unavailable.' using errcode = 'P0002';
  end if;

  request_digest := encode(sha256(convert_to(jsonb_build_array(
    p_expected_review_revision, p_action, label, selected_runs, p_expected_membership_digest
  )::text, 'UTF8')), 'hex');
  select * into review from internal.factory_failure_cohort_reviews prior
  where (prior.workspace_id, prior.factory_id, prior.cohort_id, prior.request_id) =
    (p_workspace_id, p_factory_id, p_cohort_id, p_request_id);
  if found then
    if (review.actor_member_id, review.request_digest) is distinct from (actor_member_id, request_digest) then
      raise exception 'Failure cohort review request was already used.' using errcode = 'PT409';
    end if;
    return jsonb_build_object(
      'review', internal.factory_failure_cohort_review_summary(review, true),
      'split_cohort_ids', internal.factory_failure_cohort_partition_ids(source_cohort, review.revision)
    );
  end if;

  review := internal.latest_factory_failure_cohort_review(source_cohort);
  if coalesce(review.revision, 0) <> p_expected_review_revision then
    raise exception 'Failure cohort review changed. Refresh before submitting.' using errcode = 'PT409';
  end if;
  if coalesce(review.disposition, 'open') <> 'open' then
    raise exception 'Failure cohort review is already closed.' using errcode = 'PT409';
  end if;

  if p_action = 'split' then
    -- Freeze both sides from one member snapshot. A later receipt may extend
    -- the original cohort and cannot silently become part of this decision.
    select internal.factory_failure_cohort_membership_digest(array_agg(member.id order by member.id)) as digest,
      count(distinct member.run_id) filter (where member.run_id = any(selected_runs)) as selected_run_count,
      array_agg(member.id) filter (where member.run_id = any(selected_runs)) as selected_members,
      array_agg(member.id) filter (where member.run_id <> all(selected_runs)) as remaining_members
    into membership
    from internal.visible_factory_failure_cohort_members(source_cohort) member;
    if membership.digest <> p_expected_membership_digest then
      raise exception 'Failure cohort membership changed. Refresh before splitting.' using errcode = 'PT409';
    end if;
    if membership.selected_run_count <> cardinality(selected_runs) or membership.remaining_members is null then
      raise exception 'Select a proper subset of visible failure runs.' using errcode = '22023';
    end if;
  end if;

  insert into internal.factory_failure_cohort_reviews (
    workspace_id, factory_id, cohort_id, revision, request_id, request_digest, actor_member_id, action, disposition, label
  ) values (
    p_workspace_id, p_factory_id, p_cohort_id, p_expected_review_revision + 1, p_request_id, request_digest,
    actor_member_id, p_action, case p_action when 'dismiss' then 'dismissed' when 'split' then 'split' else 'open' end,
    case when p_action = 'label' then label else review.label end
  ) returning * into review;

  if p_action = 'split' then
    insert into internal.factory_failure_cohort_partitions (workspace_id, factory_id, cohort_id, review_revision, side)
    values (p_workspace_id, p_factory_id, p_cohort_id, review.revision, 'selected') returning id into selected_cohort_id;
    insert into internal.factory_failure_cohort_partitions (workspace_id, factory_id, cohort_id, review_revision, side)
    values (p_workspace_id, p_factory_id, p_cohort_id, review.revision, 'remaining') returning id into remaining_cohort_id;
    insert into internal.factory_failure_cohort_partition_members (workspace_id, factory_id, cohort_id, partition_id, member_id)
    select p_workspace_id, p_factory_id, p_cohort_id, selected_cohort_id, member_id
    from unnest(membership.selected_members) selected(member_id)
    union all
    select p_workspace_id, p_factory_id, p_cohort_id, remaining_cohort_id, member_id
    from unnest(membership.remaining_members) remaining(member_id);
  end if;

  return jsonb_build_object(
    'review', internal.factory_failure_cohort_review_summary(review, true),
    'split_cohort_ids', internal.factory_failure_cohort_partition_ids(source_cohort, review.revision)
  );
end;
$$;

create function public.review_factory_failure_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_cohort_id uuid, p_expected_review_revision integer,
  p_request_id uuid, p_action text, p_label text default null, p_selected_run_ids uuid[] default null,
  p_expected_membership_digest text default null
) returns jsonb language sql security invoker set search_path = '' as $$
  select internal.review_factory_failure_cohort(p_workspace_id, p_factory_id, p_cohort_id, p_expected_review_revision,
    p_request_id, p_action, p_label, p_selected_run_ids, p_expected_membership_digest)
$$;

revoke all on function internal.guard_factory_failure_cohort_review(),
  internal.visible_factory_failure_cohort_members(internal.factory_failure_cohorts, uuid, uuid),
  internal.factory_failure_cohort_membership_digest(uuid[]),
  internal.factory_failure_cohort_review_summary(internal.factory_failure_cohort_reviews, boolean),
  internal.factory_failure_cohort_partition_ids(internal.factory_failure_cohorts, integer),
  internal.summarize_factory_failure_cohort(internal.factory_failure_cohort_targets,
    internal.factory_failure_cohort_reviews, uuid, boolean),
  internal.latest_factory_failure_cohort_review(internal.factory_failure_cohorts),
  internal.list_factory_failure_cohorts(uuid, uuid, integer, uuid, text, uuid, text),
  internal.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid),
  internal.review_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, text, text, uuid[], text),
  public.list_factory_failure_cohorts(uuid, uuid, integer, uuid, text, uuid, text),
  public.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid),
  public.review_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, text, text, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function internal.list_factory_failure_cohorts(uuid, uuid, integer, uuid, text, uuid, text),
  internal.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid),
  internal.review_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, text, text, uuid[], text),
  public.list_factory_failure_cohorts(uuid, uuid, integer, uuid, text, uuid, text),
  public.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid),
  public.review_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, text, text, uuid[], text)
  to authenticated;
