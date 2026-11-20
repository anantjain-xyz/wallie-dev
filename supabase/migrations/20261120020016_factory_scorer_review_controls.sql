create table public.factory_scorer_adjudications (
  id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  scorer_id uuid not null,
  attempt_id uuid not null references public.factory_evaluation_receipts(attempt_id) on delete cascade,
  actor_member_id uuid not null,
  disposition text not null check (disposition in ('confirmed', 'disputed')),
  expected_status text check (disposition = 'disputed' and expected_status in ('pass', 'fail', 'inconclusive')
    or expected_status is null),
  note text not null check (note = btrim(note) and char_length(note) between 1 and 640),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, factory_id, scorer_id)
    references public.factory_scorers(workspace_id, factory_id, id) on delete cascade
);

create table public.factory_scorer_calibration_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  scorer_id uuid not null,
  set_id uuid not null,
  revision integer not null check (revision > 0),
  scorer_revision_id uuid not null,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  adjudication_ids uuid[] not null check (cardinality(adjudication_ids) between 1 and 40),
  created_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, scorer_id, set_id, revision),
  foreign key (workspace_id, factory_id, scorer_id)
    references public.factory_scorers(workspace_id, factory_id, id) on delete cascade
);

create index factory_scorer_adjudications_attempt_idx
  on public.factory_scorer_adjudications(attempt_id, created_at desc, id desc);
create index factory_scorer_adjudications_scorer_idx
  on public.factory_scorer_adjudications(workspace_id, factory_id, scorer_id, created_at desc, id desc);

alter table public.factory_scorer_adjudications enable row level security;
alter table public.factory_scorer_calibration_revisions enable row level security;
revoke all on public.factory_scorer_adjudications, public.factory_scorer_calibration_revisions
  from public, anon, authenticated, service_role;

create function internal.preserve_factory_scorer_review_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.factory_scorers scorer where scorer.id = old.scorer_id)
      or not exists (select 1 from public.factories factory
        where (factory.workspace_id, factory.id) = (old.workspace_id, old.factory_id)) then
      return old;
    end if;
    if tg_table_name = 'factory_scorer_adjudications' then
      if not exists (select 1 from public.factory_evaluation_receipts receipt where receipt.attempt_id = old.attempt_id)
        then return old; end if;
    end if;
  end if;
  raise exception 'Scorer review history is immutable.' using errcode = '23514';
end;
$$;

create trigger factory_scorer_adjudications_immutable before update or delete
  on public.factory_scorer_adjudications for each row execute function internal.preserve_factory_scorer_review_history();
create trigger factory_scorer_calibration_revisions_immutable before update or delete
  on public.factory_scorer_calibration_revisions for each row execute function internal.preserve_factory_scorer_review_history();

create function internal.require_factory_scorer_review_scope(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns void language plpgsql stable set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if not internal.can_read_factory_evaluation_receipts(p_workspace_id, p_factory_id, p_actor_user_id) then
    raise exception 'Scorer review is unavailable.' using errcode = 'P0002';
  end if;
end;
$$;

create function internal.read_factory_evaluation_review_receipt(
  p_workspace_id uuid, p_factory_id uuid, p_attempt_id uuid
) returns public.factory_evaluation_receipts language sql stable set search_path = '' as $$
  select receipt
  from public.factory_evaluation_receipts receipt
  join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
    (receipt.workspace_id, receipt.session_id, receipt.run_id)
  join public.sessions session on (session.workspace_id, session.factory_id, session.id) =
    (receipt.workspace_id, receipt.factory_id, receipt.session_id)
  where (receipt.workspace_id, receipt.factory_id, receipt.attempt_id) =
    (p_workspace_id, p_factory_id, p_attempt_id)
$$;

create function internal.can_adjudicate_factory_evaluation(
  p_receipt public.factory_evaluation_receipts, p_actor public.workspace_members
) returns boolean language plpgsql set search_path = '' as $$
declare stage_id uuid;
begin
  if p_actor.id is null then return false; end if;
  select run.stage_id into stage_id from public.agent_runs run
  where (run.id, run.workspace_id, run.session_id) = (p_receipt.run_id, p_receipt.workspace_id, p_receipt.session_id);
  return stage_id is not null and
    internal.can_review_session_stage(p_receipt.session_id, p_receipt.workspace_id, stage_id, p_actor);
end;
$$;

create function internal.project_factory_scorer_adjudication(
  p_adjudication public.factory_scorer_adjudications, p_receipt public.factory_evaluation_receipts
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_adjudication.id, 'attempt_id', p_adjudication.attempt_id,
    'disposition', p_adjudication.disposition, 'expected_status', p_adjudication.expected_status,
    'note', case when internal.factory_evaluation_receipt_evidence_availability(p_receipt) <> 'withheld'
      then p_adjudication.note end,
    'created_at', p_adjudication.created_at
  )
$$;

create function public.adjudicate_factory_evaluation_receipt(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_attempt_id uuid, p_adjudication_id uuid,
  p_disposition text, p_note text, p_expected_status text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor public.workspace_members;
  receipt public.factory_evaluation_receipts;
  adjudication public.factory_scorer_adjudications;
begin
  perform internal.assert_checkpoint_publication_service();
  -- Match factory membership edits: lock the workspace, actor, then factory.
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then raise exception 'Scorer review is unavailable.' using errcode = 'P0002'; end if;
  select * into actor from public.workspace_members member
  where (member.workspace_id, member.user_id, member.kind, member.is_active) =
    (p_workspace_id, p_actor_user_id, 'human', true) for share;
  if actor.id is null then raise exception 'Scorer review is unavailable.' using errcode = 'P0002'; end if;
  perform 1 from public.factories factory
    where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id) for share;
  perform internal.require_factory_scorer_review_scope(p_workspace_id, p_factory_id, p_actor_user_id);
  receipt := internal.read_factory_evaluation_review_receipt(p_workspace_id, p_factory_id, p_attempt_id);
  if receipt.attempt_id is null then raise exception 'Evaluation attempt is unavailable.' using errcode = 'P0002'; end if;
  if not internal.can_adjudicate_factory_evaluation(receipt, actor) then
    raise exception 'The attempt’s stage reviewer is required.' using errcode = '42501';
  end if;
  if p_adjudication_id is null or p_disposition is null or p_disposition not in ('confirmed', 'disputed')
    or p_note is null or char_length(btrim(p_note)) not between 1 and 640
    or (p_expected_status is not null and (p_disposition <> 'disputed'
      or p_expected_status not in ('pass', 'fail', 'inconclusive'))) then
    raise exception 'Invalid evaluation adjudication.' using errcode = '22023';
  end if;

  insert into public.factory_scorer_adjudications (
    id, workspace_id, factory_id, scorer_id, attempt_id, actor_member_id, disposition, expected_status, note
  )
  select p_adjudication_id, receipt.workspace_id, receipt.factory_id, revision.scorer_id, receipt.attempt_id,
    actor.id, p_disposition, p_expected_status, btrim(p_note)
  from public.factory_scorer_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (receipt.workspace_id, receipt.factory_id, receipt.scorer_revision_id)
  on conflict (id) do nothing returning * into adjudication;

  if adjudication.id is null then
    select * into adjudication from public.factory_scorer_adjudications prior
    where prior.id = p_adjudication_id and
      (prior.workspace_id, prior.factory_id, prior.attempt_id, prior.actor_member_id,
        prior.disposition, prior.expected_status, prior.note) is not distinct from
      (p_workspace_id, p_factory_id, p_attempt_id, actor.id, p_disposition, p_expected_status, btrim(p_note));
    if adjudication.id is null then raise exception 'Adjudication already recorded.' using errcode = 'PT409'; end if;
  end if;
  return internal.project_factory_scorer_adjudication(adjudication, receipt);
end;
$$;

create function public.read_factory_evaluation_review(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_attempt_id uuid,
  p_before_created_at timestamptz default null, p_before_adjudication_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor public.workspace_members;
  receipt public.factory_evaluation_receipts;
  response jsonb;
begin
  perform internal.require_factory_scorer_review_scope(p_workspace_id, p_factory_id, p_actor_user_id);
  receipt := internal.read_factory_evaluation_review_receipt(p_workspace_id, p_factory_id, p_attempt_id);
  if receipt.attempt_id is null then raise exception 'Evaluation attempt is unavailable.' using errcode = 'P0002'; end if;
  if (p_before_created_at is null) <> (p_before_adjudication_id is null)
    or not isfinite(p_before_created_at) then
    raise exception 'Invalid adjudication page.' using errcode = '22023';
  end if;
  select * into actor from public.workspace_members member
  where (member.workspace_id, member.user_id, member.kind, member.is_active) =
    (p_workspace_id, p_actor_user_id, 'human', true);

  with page as materialized (
    select review as item, review.id, review.created_at
    from public.factory_scorer_adjudications review
    where (review.workspace_id, review.factory_id, review.attempt_id) = (p_workspace_id, p_factory_id, p_attempt_id)
      and (p_before_created_at is null or (review.created_at, review.id) < (p_before_created_at, p_before_adjudication_id))
    order by review.created_at desc, review.id desc limit 21
  ), visible as (
    select * from page order by created_at desc, id desc limit 20
  ), boundary as (
    select * from visible where (select count(*) from page) > 20 order by created_at, id limit 1
  )
  select jsonb_build_object(
    'can_adjudicate', internal.can_adjudicate_factory_evaluation(receipt, actor),
    'adjudications', coalesce((select jsonb_agg(internal.project_factory_scorer_adjudication(item, receipt)
      order by created_at desc, id desc) from visible), '[]'),
    'has_more', exists(select 1 from boundary),
    'next_before_created_at', (select created_at from boundary),
    'next_before_adjudication_id', (select id from boundary)
  ) into response;
  return response;
end;
$$;

create function internal.project_factory_scorer_calibration_revision(p_row public.factory_scorer_calibration_revisions)
returns jsonb language sql stable strict set search_path = '' as $$
  select jsonb_build_object(
    'id', p_row.id, 'set_id', p_row.set_id, 'revision', p_row.revision, 'name', p_row.name,
    'scorer_revision_id', p_row.scorer_revision_id, 'adjudication_ids', p_row.adjudication_ids, 'created_at', p_row.created_at
  )
$$;

create function public.save_factory_scorer_calibration_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_scorer_id uuid, p_set_id uuid,
  p_expected_revision integer, p_scorer_revision_id uuid, p_name text, p_adjudication_ids uuid[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  manager_id uuid;
  prior public.factory_scorer_calibration_revisions;
  saved public.factory_scorer_calibration_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  manager_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  perform 1 from public.factory_scorers scorer
  where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, p_scorer_id) for no key update;
  if not found then raise exception 'Scorer is unavailable.' using errcode = 'P0002'; end if;

  if p_set_id is null or p_expected_revision is null or p_expected_revision not between 0 and 2147483646
    or p_name is null or char_length(btrim(p_name)) not between 1 and 120
    or p_adjudication_ids is null or coalesce(array_ndims(p_adjudication_ids), 0) <> 1
    or cardinality(p_adjudication_ids) not between 1 and 40
    or not exists(select 1 from public.factory_scorer_revisions version
      where (version.workspace_id, version.factory_id, version.scorer_id, version.id) =
        (p_workspace_id, p_factory_id, p_scorer_id, p_scorer_revision_id))
    or cardinality(p_adjudication_ids) <> (
      select count(*) from public.factory_scorer_adjudications review
      where (review.workspace_id, review.factory_id, review.scorer_id) = (p_workspace_id, p_factory_id, p_scorer_id)
        and review.id = any(p_adjudication_ids)
    ) then raise exception 'Invalid scorer calibration set.' using errcode = '22023'; end if;

  select * into prior from public.factory_scorer_calibration_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.scorer_id, revision.set_id) =
    (p_workspace_id, p_factory_id, p_scorer_id, p_set_id)
  order by revision.revision desc limit 1;
  if coalesce(prior.revision, 0) <> p_expected_revision then
    if (prior.revision, prior.scorer_revision_id, prior.name, prior.adjudication_ids, prior.created_by_member_id)
      is not distinct from (p_expected_revision + 1, p_scorer_revision_id, btrim(p_name), p_adjudication_ids, manager_id) then
      return internal.project_factory_scorer_calibration_revision(prior);
    end if;
    raise exception 'Calibration set changed. Reload before publishing.' using errcode = 'PT409';
  end if;

  insert into public.factory_scorer_calibration_revisions(
    workspace_id, factory_id, scorer_id, set_id, revision, scorer_revision_id, name, adjudication_ids, created_by_member_id
  ) values (p_workspace_id, p_factory_id, p_scorer_id, p_set_id, p_expected_revision + 1,
    p_scorer_revision_id, btrim(p_name), p_adjudication_ids, manager_id)
  returning * into saved;
  return internal.project_factory_scorer_calibration_revision(saved);
end;
$$;

create function public.read_factory_scorer_calibration(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_scorer_id uuid,
  p_set_id uuid default null, p_before_revision integer default null,
  p_before_set_at timestamptz default null, p_before_set_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  can_manage boolean;
  candidates jsonb := '[]';
  response jsonb;
begin
  perform internal.require_factory_scorer_review_scope(p_workspace_id, p_factory_id, p_actor_user_id);
  if not exists (select 1 from public.factory_scorers scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, p_scorer_id)) then
    raise exception 'Scorer is unavailable.' using errcode = 'P0002';
  end if;
  if (p_set_id is null and p_before_revision is not null)
    or (p_set_id is not null and p_before_set_at is not null)
    or p_before_revision < 1
    or (p_before_set_at is null) <> (p_before_set_id is null)
    or not isfinite(p_before_set_at) then
    raise exception 'Invalid calibration page.' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.workspace_members member
    where (member.workspace_id, member.user_id, member.kind, member.is_active) = (p_workspace_id, p_actor_user_id, 'human', true)
      and (member.role in ('owner', 'admin') or exists (
        select 1 from public.factory_members factory_member
        where (factory_member.workspace_id, factory_member.factory_id, factory_member.member_id) =
          (p_workspace_id, p_factory_id, member.id) and factory_member.role = 'manager' and factory_member.revoked_at is null
      ))
  ) into can_manage;

  if can_manage then
    with choices as materialized (
      select review as item, review.created_at, review.id, receipt
      from public.factory_scorer_adjudications review
      join public.factory_evaluation_receipts receipt on (receipt.workspace_id, receipt.factory_id, receipt.attempt_id) =
        (review.workspace_id, review.factory_id, review.attempt_id)
      join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
        (receipt.workspace_id, receipt.session_id, receipt.run_id)
      join public.sessions session on (session.workspace_id, session.factory_id, session.id) =
        (receipt.workspace_id, receipt.factory_id, receipt.session_id)
      where (review.workspace_id, review.factory_id, review.scorer_id) = (p_workspace_id, p_factory_id, p_scorer_id)
      order by review.created_at desc, review.id desc limit 40
    )
    select coalesce(jsonb_agg(internal.project_factory_scorer_adjudication(item, receipt)
      || jsonb_build_object('status', (receipt).status, 'reason', (receipt).reason)
      order by created_at desc, id desc), '[]') into candidates from choices;
  end if;

  with latest as (
    select distinct on (version_row.set_id) version_row as item, version_row.set_id,
      version_row.revision, version_row.created_at
    from public.factory_scorer_calibration_revisions version_row
    where (version_row.workspace_id, version_row.factory_id, version_row.scorer_id) =
      (p_workspace_id, p_factory_id, p_scorer_id)
      and p_set_id is null
    order by version_row.set_id, version_row.revision desc
  ), options as (
    select * from latest where p_before_set_at is null or (created_at, set_id) < (p_before_set_at, p_before_set_id)
    union all
    select version_row, version_row.set_id, version_row.revision, version_row.created_at
    from public.factory_scorer_calibration_revisions version_row
    where (version_row.workspace_id, version_row.factory_id, version_row.scorer_id, version_row.set_id) =
      (p_workspace_id, p_factory_id, p_scorer_id, p_set_id)
      and (p_before_revision is null or version_row.revision < p_before_revision)
  ), page as materialized (
    select * from options
    order by (case when p_set_id is not null then revision end) desc nulls last, created_at desc, set_id desc limit 21
  ), visible as (
    select * from page
    order by (case when p_set_id is not null then revision end) desc nulls last, created_at desc, set_id desc limit 20
  ), boundary as (
    select * from visible where (select count(*) from page) > 20
    order by (case when p_set_id is not null then revision end) asc nulls last, created_at, set_id limit 1
  )
  select jsonb_build_object(
    'versions', coalesce((select jsonb_agg(internal.project_factory_scorer_calibration_revision(item)
      order by (case when p_set_id is not null then revision end) desc nulls last, created_at desc, set_id desc) from visible), '[]'),
    'candidates', candidates,
    'next_before_revision', (select revision from boundary where p_set_id is not null),
    'next_before_set_at', (select created_at from boundary where p_set_id is null),
    'next_before_set_id', (select set_id from boundary where p_set_id is null)
  ) into response;
  return response;
end;
$$;

revoke all on function internal.preserve_factory_scorer_review_history(),
  internal.require_factory_scorer_review_scope(uuid, uuid, uuid),
  internal.read_factory_evaluation_review_receipt(uuid, uuid, uuid),
  internal.can_adjudicate_factory_evaluation(public.factory_evaluation_receipts, public.workspace_members),
  internal.project_factory_scorer_adjudication(public.factory_scorer_adjudications, public.factory_evaluation_receipts),
  internal.project_factory_scorer_calibration_revision(public.factory_scorer_calibration_revisions),
  public.adjudicate_factory_evaluation_receipt(uuid, uuid, uuid, uuid, uuid, text, text, text),
  public.read_factory_evaluation_review(uuid, uuid, uuid, uuid, timestamptz, uuid),
  public.save_factory_scorer_calibration_revision(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid[]),
  public.read_factory_scorer_calibration(uuid, uuid, uuid, uuid, uuid, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.adjudicate_factory_evaluation_receipt(uuid, uuid, uuid, uuid, uuid, text, text, text),
  public.read_factory_evaluation_review(uuid, uuid, uuid, uuid, timestamptz, uuid),
  public.save_factory_scorer_calibration_revision(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid[]),
  public.read_factory_scorer_calibration(uuid, uuid, uuid, uuid, uuid, integer, timestamptz, uuid)
  to service_role;
