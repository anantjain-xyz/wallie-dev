create table public.factory_benchmark_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  source_run_id uuid not null,
  source_session_id uuid not null,
  source_provenance jsonb not null check (jsonb_typeof(source_provenance) = 'object'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, source_run_id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table public.factory_benchmark_task_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  task_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  acceptance_criteria text not null check (btrim(acceptance_criteria) <> ''),
  tags text[] not null,
  replay_eligibility text not null check (replay_eligibility in ('unverified', 'eligible', 'ineligible')),
  eligibility_reason text check (btrim(eligibility_reason) <> ''),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  check (replay_eligibility <> 'ineligible' or eligibility_reason is not null),
  check (replay_eligibility <> 'eligible' or eligibility_reason is null),
  unique (task_id, revision_number),
  unique (workspace_id, factory_id, task_id, id),
  foreign key (workspace_id, factory_id, task_id)
    references public.factory_benchmark_tasks(workspace_id, factory_id, id) on delete cascade
);

create table public.factory_benchmark_suites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table public.factory_benchmark_suite_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  suite_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  purpose text not null check (purpose in ('regression', 'holdout')),
  selection_tags text[] check (cardinality(selection_tags) > 0),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (suite_id, revision_number),
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id, suite_id)
    references public.factory_benchmark_suites(workspace_id, factory_id, id) on delete cascade
);

create table public.factory_benchmark_suite_members (
  workspace_id uuid not null,
  factory_id uuid not null,
  suite_revision_id uuid not null,
  task_id uuid not null,
  task_revision_id uuid not null,
  primary key (suite_revision_id, task_id),
  foreign key (workspace_id, factory_id, suite_revision_id)
    references public.factory_benchmark_suite_revisions(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, task_id, task_revision_id)
    references public.factory_benchmark_task_revisions(workspace_id, factory_id, task_id, id) on delete cascade
);
create index factory_benchmark_suite_members_task_revision_idx
  on public.factory_benchmark_suite_members(workspace_id, factory_id, task_id, task_revision_id);

alter table public.factory_benchmark_tasks enable row level security;
alter table public.factory_benchmark_task_revisions enable row level security;
alter table public.factory_benchmark_suites enable row level security;
alter table public.factory_benchmark_suite_revisions enable row level security;
alter table public.factory_benchmark_suite_members enable row level security;
revoke all on public.factory_benchmark_tasks, public.factory_benchmark_task_revisions,
  public.factory_benchmark_suites, public.factory_benchmark_suite_revisions, public.factory_benchmark_suite_members
  from public, anon, authenticated, service_role;
grant select on public.factory_benchmark_tasks, public.factory_benchmark_task_revisions,
  public.factory_benchmark_suites, public.factory_benchmark_suite_revisions, public.factory_benchmark_suite_members
  to authenticated, service_role;

create policy factory_benchmark_tasks_select on public.factory_benchmark_tasks for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_benchmark_task_revisions_select on public.factory_benchmark_task_revisions for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_benchmark_suites_select on public.factory_benchmark_suites for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_benchmark_suite_revisions_select on public.factory_benchmark_suite_revisions for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_benchmark_suite_members_select on public.factory_benchmark_suite_members for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));

create function internal.preserve_factory_benchmark_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factories where (workspace_id, id) = (old.workspace_id, old.factory_id)
  ) then
    return old;
  end if;
  raise exception 'Benchmark history is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_benchmark_history() from public, anon, authenticated, service_role;

create trigger preserve_factory_benchmark_tasks before update or delete on public.factory_benchmark_tasks
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_factory_benchmark_task_revisions before update or delete on public.factory_benchmark_task_revisions
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_factory_benchmark_suites before update or delete on public.factory_benchmark_suites
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_factory_benchmark_suite_revisions before update or delete on public.factory_benchmark_suite_revisions
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_factory_benchmark_suite_members before update or delete on public.factory_benchmark_suite_members
  for each row execute function internal.preserve_factory_benchmark_history();

create function internal.normalize_factory_benchmark_tags(p_tags text[])
returns text[] language plpgsql immutable set search_path = '' as $$
begin
  if p_tags is null or array_ndims(p_tags) > 1 or exists (
    select 1 from unnest(p_tags) as tags(tag) where tag is null or btrim(tag) = ''
  ) then
    raise exception 'Provide a list of nonempty benchmark tags.' using errcode = '22023';
  end if;
  return array(
    select distinct lower(btrim(tag) collate "C") as normalized
    from unnest(p_tags) as tags(tag) order by normalized
  );
end;
$$;
revoke all on function internal.normalize_factory_benchmark_tags(text[]) from public, anon, authenticated, service_role;

create function public.create_factory_benchmark_task(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_source_run_id uuid, p_name text, p_acceptance_criteria text, p_tags text[],
  p_replay_eligibility text default 'unverified', p_eligibility_reason text default null
) returns public.factory_benchmark_task_revisions
language plpgsql security definer set search_path = '' as $$
declare task_id uuid; result public.factory_benchmark_task_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  insert into public.factory_benchmark_tasks(
    workspace_id, factory_id, source_run_id, source_session_id, source_provenance, created_by
  )
  select p_workspace_id, p_factory_id, run.id, run.session_id, jsonb_build_object(
    'runId', run.id, 'sessionId', run.session_id, 'stageSlug', run.stage_slug, 'attempt', run.attempt_count,
    'modelProvider', run.model_provider, 'modelName', run.model_name,
    'runType', run.run_type, 'definitionRevisionId', manifest.definition_revision_id,
    'definitionDigest', manifest.definition_digest, 'inputSha', manifest.input_sha,
    'promptSha256', manifest.prompt_sha256
  ), p_actor_user_id
  from public.agent_runs run
  join public.sessions session on (session.workspace_id, session.id) = (run.workspace_id, run.session_id)
  left join public.session_attempt_manifests manifest
    on (manifest.workspace_id, manifest.session_id, manifest.run_id) = (run.workspace_id, run.session_id, run.id)
    and manifest.attempt_count = run.attempt_count
  where run.id = p_source_run_id and (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
  returning id into task_id;
  if not found then
    raise exception 'Source run is unavailable in this factory.' using errcode = 'P0002';
  end if;

  insert into public.factory_benchmark_task_revisions(
    workspace_id, factory_id, task_id, revision_number, name, acceptance_criteria, tags,
    replay_eligibility, eligibility_reason, created_by
  ) values (
    p_workspace_id, p_factory_id, task_id, 1, btrim(p_name), p_acceptance_criteria,
    internal.normalize_factory_benchmark_tags(p_tags), p_replay_eligibility, p_eligibility_reason, p_actor_user_id
  ) returning * into result;
  return result;
end;
$$;

create function public.save_factory_benchmark_task_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_task_id uuid, p_expected_revision_id uuid, p_name text, p_acceptance_criteria text, p_tags text[],
  p_replay_eligibility text, p_eligibility_reason text default null
) returns public.factory_benchmark_task_revisions
language plpgsql security definer set search_path = '' as $$
declare current_revision public.factory_benchmark_task_revisions; result public.factory_benchmark_task_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select * into current_revision from public.factory_benchmark_task_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.task_id) = (p_workspace_id, p_factory_id, p_task_id)
  order by revision.revision_number desc limit 1;
  if not found then
    raise exception 'Benchmark task is unavailable in this factory.' using errcode = 'P0002';
  end if;
  if p_expected_revision_id is distinct from current_revision.id then
    raise exception 'The benchmark task changed. Reload its revision before saving.' using errcode = 'PT409';
  end if;

  insert into public.factory_benchmark_task_revisions(
    workspace_id, factory_id, task_id, revision_number, name, acceptance_criteria, tags,
    replay_eligibility, eligibility_reason, created_by
  ) values (
    p_workspace_id, p_factory_id, p_task_id, current_revision.revision_number + 1, btrim(p_name), p_acceptance_criteria,
    internal.normalize_factory_benchmark_tags(p_tags), p_replay_eligibility, p_eligibility_reason, p_actor_user_id
  ) returning * into result;
  return result;
end;
$$;

create function public.save_factory_benchmark_suite_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_name text, p_purpose text, p_suite_id uuid default null, p_expected_revision_id uuid default null,
  p_task_revision_ids uuid[] default null, p_selection_tags text[] default null
) returns public.factory_benchmark_suite_revisions
language plpgsql security definer set search_path = '' as $$
declare
  suite_id uuid := p_suite_id;
  current_revision public.factory_benchmark_suite_revisions;
  result public.factory_benchmark_suite_revisions;
  selection_tags text[];
  matched_count integer;
  distinct_tasks integer;
begin
  perform internal.assert_checkpoint_publication_service();
  -- The manager check locks the factory for both task and suite writes.
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  if (p_selection_tags is null) = (p_task_revision_ids is null) then
    raise exception 'Select benchmark tasks by revision IDs or by tags.' using errcode = '22023';
  end if;
  if p_selection_tags is not null then
    selection_tags := internal.normalize_factory_benchmark_tags(p_selection_tags);
    if cardinality(selection_tags) = 0 then
      raise exception 'Tag selection requires at least one tag.' using errcode = '22023';
    end if;
  else
    if array_ndims(p_task_revision_ids) > 1 then
      raise exception 'Provide a list of task revision IDs.' using errcode = '22023';
    end if;
    select count(*), count(distinct revision.task_id) into matched_count, distinct_tasks
    from unnest(p_task_revision_ids) as selected(revision_id)
    join public.factory_benchmark_task_revisions revision
      on (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, selected.revision_id);
    if matched_count <> cardinality(p_task_revision_ids) then
      raise exception 'A benchmark task revision is unavailable in this factory.' using errcode = 'PT422';
    end if;
    if matched_count <> distinct_tasks then
      raise exception 'A suite revision may include a benchmark task only once.' using errcode = '22023';
    end if;
  end if;

  if p_suite_id is null then
    if p_expected_revision_id is not null then
      raise exception 'A new benchmark suite has no base revision.' using errcode = '22023';
    end if;
    insert into public.factory_benchmark_suites(workspace_id, factory_id, created_by)
    values (p_workspace_id, p_factory_id, p_actor_user_id) returning id into suite_id;
  else
    select * into current_revision from public.factory_benchmark_suite_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.suite_id) = (p_workspace_id, p_factory_id, p_suite_id)
    order by revision.revision_number desc limit 1;
    if not found then
      raise exception 'Benchmark suite is unavailable in this factory.' using errcode = 'P0002';
    end if;
    if p_expected_revision_id is distinct from current_revision.id then
      raise exception 'The benchmark suite changed. Reload its revision before saving.' using errcode = 'PT409';
    end if;
  end if;

  insert into public.factory_benchmark_suite_revisions(
    workspace_id, factory_id, suite_id, revision_number, name, purpose, selection_tags, created_by
  ) values (
    p_workspace_id, p_factory_id, suite_id, coalesce(current_revision.revision_number, 0) + 1,
    btrim(p_name), p_purpose, selection_tags, p_actor_user_id
  ) returning * into result;

  if p_task_revision_ids is not null then
    insert into public.factory_benchmark_suite_members(workspace_id, factory_id, suite_revision_id, task_id, task_revision_id)
    select p_workspace_id, p_factory_id, result.id, revision.task_id, revision.id
    from public.factory_benchmark_task_revisions revision
    where (revision.workspace_id, revision.factory_id) = (p_workspace_id, p_factory_id)
      and revision.id = any(p_task_revision_ids);
  else
    insert into public.factory_benchmark_suite_members(workspace_id, factory_id, suite_revision_id, task_id, task_revision_id)
    select p_workspace_id, p_factory_id, result.id, task.id, latest.id
    from public.factory_benchmark_tasks task
    cross join lateral (
      select revision.id, revision.tags from public.factory_benchmark_task_revisions revision
      where revision.task_id = task.id order by revision.revision_number desc limit 1
    ) latest
    where (task.workspace_id, task.factory_id) = (p_workspace_id, p_factory_id)
      and latest.tags @> selection_tags;
  end if;
  return result;
end;
$$;

revoke all on function
  public.create_factory_benchmark_task(uuid, uuid, uuid, uuid, text, text, text[], text, text),
  public.save_factory_benchmark_task_revision(uuid, uuid, uuid, uuid, uuid, text, text, text[], text, text),
  public.save_factory_benchmark_suite_revision(uuid, uuid, uuid, text, text, uuid, uuid, uuid[], text[])
  from public, anon, authenticated, service_role;
grant execute on function
  public.create_factory_benchmark_task(uuid, uuid, uuid, uuid, text, text, text[], text, text),
  public.save_factory_benchmark_task_revision(uuid, uuid, uuid, uuid, uuid, text, text, text[], text, text),
  public.save_factory_benchmark_suite_revision(uuid, uuid, uuid, text, text, uuid, uuid, uuid[], text[])
  to service_role;

comment on table public.factory_benchmark_tasks is
  'Stable benchmark identities with provenance copied at creation. Source IDs remain attributable if source rows are removed.';
comment on column public.factory_benchmark_tasks.source_provenance is
  'Run identity and evidence digests only. Retention and current permissions must be checked before replay.';
comment on table public.factory_benchmark_suite_members is
  'Frozen membership for a suite revision, including the exact task revision used.';
