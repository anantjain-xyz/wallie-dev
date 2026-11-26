create or replace function internal.project_factory_scorer_calibration_revision(p_row public.factory_scorer_calibration_revisions)
returns jsonb language sql stable strict set search_path = '' as $$
  select jsonb_build_object(
    'id', p_row.id, 'set_id', p_row.set_id, 'revision', p_row.revision, 'name', p_row.name,
    'scorer_revision_id', p_row.scorer_revision_id, 'adjudication_ids', p_row.adjudication_ids, 'created_at', p_row.created_at,
    'scorer_revision_number', (
      select revision.revision_number from public.factory_scorer_revisions revision
      where (revision.workspace_id, revision.factory_id, revision.scorer_id, revision.id) =
        (p_row.workspace_id, p_row.factory_id, p_row.scorer_id, p_row.scorer_revision_id)
    ),
    'case_refs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'adjudication_id', chosen.id,
        'attempt_id', case when session.id is not null then receipt.attempt_id end,
        'run_id', case when session.id is not null then receipt.run_id end,
        'session_title', case when not exists (
          select 1 from public.session_retained_content_erasures erasure
          where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
            (session.workspace_id, session.factory_id, session.id)
        ) then session.title end,
        'stage_name', coalesce(run.stage_name, run.stage_slug),
        'attempt_number', receipt.attempt_number,
        'created_at', review.created_at,
        'disposition', review.disposition,
        'status', receipt.status,
        'expected_status', review.expected_status
      ) order by chosen.position)
      from unnest(p_row.adjudication_ids) with ordinality chosen(id, position)
      left join public.factory_scorer_adjudications review on
        (review.workspace_id, review.factory_id, review.scorer_id, review.id) =
        (p_row.workspace_id, p_row.factory_id, p_row.scorer_id, chosen.id)
      left join public.factory_evaluation_receipts receipt on (receipt.workspace_id, receipt.factory_id, receipt.attempt_id) =
        (review.workspace_id, review.factory_id, review.attempt_id)
      left join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
        (receipt.workspace_id, receipt.session_id, receipt.run_id)
      left join public.sessions session on (session.workspace_id, session.factory_id, session.id) =
        (receipt.workspace_id, receipt.factory_id, receipt.session_id)
    ), '[]')
  )
$$;

create or replace function public.read_factory_scorer_calibration(
  p_workspace_id uuid, p_factory_id uuid, p_scorer_id uuid,
  p_set_id uuid default null, p_before_revision integer default null,
  p_before_set_at timestamptz default null, p_before_set_id uuid default null,
  p_before_candidate_at timestamptz default null, p_before_candidate_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  can_manage boolean;
  candidates jsonb := '[]';
  candidate_boundary_at timestamptz;
  candidate_boundary_id uuid;
  response jsonb;
begin
  perform internal.require_factory_score_read(p_workspace_id, p_factory_id);
  if not exists (select 1 from public.factory_scorers scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, p_scorer_id)) then
    raise exception 'Scorer is unavailable.' using errcode = 'P0002';
  end if;
  if (p_set_id is null and p_before_revision is not null)
    or (p_set_id is not null and p_before_set_at is not null)
    or p_before_revision < 1
    or (p_before_set_at is null) <> (p_before_set_id is null)
    or (p_before_candidate_at is null) <> (p_before_candidate_id is null)
    or not isfinite(p_before_set_at) or not isfinite(p_before_candidate_at) then
    raise exception 'Invalid calibration page.' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.workspace_members member
    where (member.workspace_id, member.user_id, member.kind, member.is_active) = (p_workspace_id, auth.uid(), 'human', true)
      and (member.role in ('owner', 'admin') or exists (
        select 1 from public.factory_members factory_member
        where (factory_member.workspace_id, factory_member.factory_id, factory_member.member_id) =
          (p_workspace_id, p_factory_id, member.id) and factory_member.role = 'manager' and factory_member.revoked_at is null
      ))
  ) into can_manage;

  if can_manage then
    with choice_page as materialized (
      select review as item, review.created_at, review.id, receipt,
        case when not exists (
          select 1 from public.session_retained_content_erasures erasure
          where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
            (session.workspace_id, session.factory_id, session.id)
        ) then session.title end as session_title,
        coalesce(run.stage_name, run.stage_slug) as stage_name
      from public.factory_scorer_adjudications review
      join public.factory_evaluation_receipts receipt on (receipt.workspace_id, receipt.factory_id, receipt.attempt_id) =
        (review.workspace_id, review.factory_id, review.attempt_id)
      join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
        (receipt.workspace_id, receipt.session_id, receipt.run_id)
      join public.sessions session on (session.workspace_id, session.factory_id, session.id) =
        (receipt.workspace_id, receipt.factory_id, receipt.session_id)
      where (review.workspace_id, review.factory_id, review.scorer_id) = (p_workspace_id, p_factory_id, p_scorer_id)
        and (p_before_candidate_at is null or (review.created_at, review.id) < (p_before_candidate_at, p_before_candidate_id))
      order by review.created_at desc, review.id desc limit 41
    ), choices as (
      select * from choice_page order by created_at desc, id desc limit 40
    ), choice_boundary as (
      select * from choices where (select count(*) from choice_page) > 40 order by created_at, id limit 1
    )
    select coalesce(jsonb_agg(internal.project_factory_scorer_adjudication(item, receipt)
      || jsonb_build_object('status', (receipt).status, 'reason', (receipt).reason,
        'run_id', (receipt).run_id, 'attempt_number', (receipt).attempt_number,
        'session_title', session_title, 'stage_name', stage_name)
      order by created_at desc, id desc), '[]'),
      (select created_at from choice_boundary), (select id from choice_boundary)
    into candidates, candidate_boundary_at, candidate_boundary_id from choices;
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
    'next_before_set_id', (select set_id from boundary where p_set_id is null),
    'next_before_candidate_at', candidate_boundary_at,
    'next_before_candidate_id', candidate_boundary_id
  ) into response;
  return response;
end;
$$;
