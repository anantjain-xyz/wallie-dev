create table internal.factory_improvement_review_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  proposal_id uuid not null,
  proposal_revision_id uuid not null,
  version integer not null check (version > 0),
  request_id uuid not null,
  actor_member_id uuid not null,
  action text not null check (action in ('comment', 'investigate', 'revise', 'dismiss')),
  note text not null check (char_length(note) <= 4000 and (action <> 'comment' or btrim(note) <> '')),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, request_id),
  unique (workspace_id, factory_id, proposal_id, proposal_revision_id, version),
  foreign key (workspace_id, factory_id, proposal_id, proposal_revision_id)
    references internal.factory_improvement_proposal_revisions(workspace_id, factory_id, proposal_id, id)
    on delete cascade
);

alter table internal.factory_improvement_review_events enable row level security;
revoke all on internal.factory_improvement_review_events from public, anon, authenticated, service_role;

create trigger preserve_factory_improvement_review_events
  before update or delete on internal.factory_improvement_review_events
  for each row execute function internal.preserve_factory_improvement_history();

create function internal.project_factory_improvement_review_event(event internal.factory_improvement_review_events)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', event.id, 'version', event.version, 'action', event.action,
    'note', event.note, 'actorMemberId', event.actor_member_id, 'createdAt', event.created_at,
    'actorName', (select coalesce(nullif(btrim(member.full_name), ''), nullif(btrim(member.username), ''))
      from public.workspace_members member where (member.workspace_id, member.id) =
        (event.workspace_id, event.actor_member_id)))
$$;

create function internal.factory_improvement_disposition(
  p_workspace_id uuid, p_factory_id uuid, p_proposal_id uuid, p_revision_id uuid
) returns text language sql stable set search_path = '' as $$
  select coalesce((select case event.action when 'dismiss' then 'dismissed' else event.action end
    from internal.factory_improvement_review_events event
    where (event.workspace_id, event.factory_id, event.proposal_id, event.proposal_revision_id) =
      (p_workspace_id, p_factory_id, p_proposal_id, p_revision_id) and event.action <> 'comment'
    order by event.version desc limit 1), 'open')
$$;

create function internal.list_factory_improvement_workbench(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer, p_after_proposal_id uuid, p_cohort_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  after_created_at timestamptz;
begin
  if auth.uid() is null or not internal.can_access_factory(p_workspace_id, p_factory_id) then
    raise exception 'Factory improvements are unavailable.' using errcode = 'P0002';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Provide a valid improvements page size.' using errcode = '22023';
  end if;
  if p_after_proposal_id is not null then
    select first.created_at into after_created_at
    from internal.factory_improvement_proposal_revisions first
    where (first.workspace_id, first.factory_id, first.proposal_id, first.revision_number) =
      (p_workspace_id, p_factory_id, p_after_proposal_id, 1);
    if not found then raise exception 'Proposal page is unavailable.' using errcode = 'P0002'; end if;
  end if;

  return (
    with page as materialized (
      select first.created_at as opened_at, proposal.id as proposal_id, proposal.diagnosis_id,
        diagnosis.cohort_id, latest.id as revision_id, latest.revision_number, latest.candidate_revision_id,
        latest.intent, latest.created_at,
        row_number() over (order by first.created_at desc, proposal.id desc) as position
      from internal.factory_improvement_proposals proposal
      join internal.factory_improvement_proposal_revisions first on
        (first.workspace_id, first.factory_id, first.proposal_id, first.revision_number) =
        (proposal.workspace_id, proposal.factory_id, proposal.id, 1)
      join lateral (
        select revision.id, revision.revision_number, revision.candidate_revision_id, revision.intent, revision.created_at
        from internal.factory_improvement_proposal_revisions revision
        where (revision.workspace_id, revision.factory_id, revision.proposal_id) =
          (proposal.workspace_id, proposal.factory_id, proposal.id)
        order by revision.revision_number desc limit 1
      ) latest on true
      left join internal.factory_diagnoses diagnosis on
        (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.id) = (proposal.workspace_id, proposal.factory_id, proposal.diagnosis_id)
      where (proposal.workspace_id, proposal.factory_id) = (p_workspace_id, p_factory_id)
        and (p_cohort_id is null or diagnosis.cohort_id = p_cohort_id)
        and (p_after_proposal_id is null or (first.created_at, proposal.id) < (after_created_at, p_after_proposal_id))
      order by first.created_at desc, proposal.id desc limit p_limit + 1
    )
    select jsonb_build_object('proposals', coalesce(jsonb_agg(jsonb_build_object(
      'proposalId', item.proposal_id, 'revisionId', item.revision_id, 'revisionNumber', item.revision_number,
      'diagnosisId', item.diagnosis_id, 'cohortId', item.cohort_id, 'rationale', item.intent->'rationale',
      'expectedBenefit', item.intent->'expectedBenefit', 'createdAt', item.created_at,
      'status', case when item.candidate_revision_id is null then 'invalid' else 'compiled' end,
      'baseCurrent', coalesce(item.intent->'base' = internal.current_factory_improvement_base(p_workspace_id, p_factory_id), false),
      'disposition', internal.factory_improvement_disposition(p_workspace_id, p_factory_id, item.proposal_id, item.revision_id)
    ) order by item.position) filter (where item.position <= p_limit), '[]'::jsonb),
    'nextProposalId', case when count(*) > p_limit then (array_agg(item.proposal_id order by item.position))[p_limit] end)
    from page item
  );
end;
$$;

create function internal.read_factory_improvement_workbench(
  p_workspace_id uuid, p_factory_id uuid, p_proposal_id uuid, p_revision_id uuid, p_before_event integer
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  latest_id uuid;
  selected internal.factory_improvement_proposal_revisions;
  cohort_id uuid;
  disposition text;
  version integer;
  events jsonb;
  next_before integer;
  revisions jsonb;
begin
  if auth.uid() is null or not internal.can_access_factory(p_workspace_id, p_factory_id) then
    raise exception 'Improvement proposal is unavailable.' using errcode = 'P0002';
  end if;
  if p_before_event is not null and p_before_event < 1 then
    raise exception 'Provide a valid discussion cursor.' using errcode = '22023';
  end if;
  select revision.id into latest_id from internal.factory_improvement_proposal_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.proposal_id) =
    (p_workspace_id, p_factory_id, p_proposal_id)
  order by revision.revision_number desc limit 1;
  if not found then return null; end if;

  select revision.* into selected from internal.factory_improvement_proposal_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.proposal_id, revision.id) =
    (p_workspace_id, p_factory_id, p_proposal_id, coalesce(p_revision_id, latest_id));
  if not found then return null; end if;

  select diagnosis.cohort_id into cohort_id from internal.factory_improvement_proposals proposal
  join internal.factory_diagnoses diagnosis on (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.id) =
    (proposal.workspace_id, proposal.factory_id, proposal.diagnosis_id)
  where (proposal.workspace_id, proposal.factory_id, proposal.id) = (p_workspace_id, p_factory_id, p_proposal_id);
  disposition := internal.factory_improvement_disposition(p_workspace_id, p_factory_id, p_proposal_id, selected.id);

  select coalesce(max(event.version), 0) into version from internal.factory_improvement_review_events event
  where (event.workspace_id, event.factory_id, event.proposal_id, event.proposal_revision_id) =
    (p_workspace_id, p_factory_id, p_proposal_id, selected.id);
  with page as (
    select event, event.version, row_number() over (order by event.version desc) as position
    from internal.factory_improvement_review_events event
    where (event.workspace_id, event.factory_id, event.proposal_id, event.proposal_revision_id) =
      (p_workspace_id, p_factory_id, p_proposal_id, selected.id)
      and (p_before_event is null or event.version < p_before_event)
    order by event.version desc limit 51
  )
  select coalesce(jsonb_agg(internal.project_factory_improvement_review_event(page.event) order by page.version)
    filter (where page.position <= 50), '[]'::jsonb),
    case when count(*) > 50 then max(page.version) filter (where page.position = 50) end
  into events, next_before from page;

  select coalesce(jsonb_agg(jsonb_build_object('revisionId', history.id, 'revisionNumber', history.revision_number,
    'createdAt', history.created_at, 'status', case when history.candidate_revision_id is null then 'invalid' else 'compiled' end)
    order by history.revision_number desc), '[]'::jsonb) into revisions
  from (select revision.id, revision.revision_number, revision.created_at, revision.candidate_revision_id
    from internal.factory_improvement_proposal_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.proposal_id) = (p_workspace_id, p_factory_id, p_proposal_id)
    order by revision.revision_number desc limit 25) history;

  return jsonb_build_object('proposal', internal.project_factory_improvement_revision(selected),
    'latestRevisionId', latest_id, 'revisions', revisions, 'cohortId', cohort_id,
    'review', jsonb_build_object('version', version, 'disposition', disposition, 'events', events,
      'nextEventBefore', next_before, 'canReview', selected.id = latest_id and disposition <> 'dismissed'
        and internal.can_manage_factory(p_workspace_id, p_factory_id) and exists (
          select 1 from public.factories factory where (factory.workspace_id, factory.id, factory.status) =
            (p_workspace_id, p_factory_id, 'active'))));
end;
$$;

create function public.save_factory_improvement_review_event(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_proposal_id uuid, p_proposal_revision_id uuid,
  p_expected_review_version integer, p_request_id uuid, p_action text, p_note text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  latest_id uuid;
  version integer;
  saved internal.factory_improvement_review_events;
begin
  perform internal.assert_checkpoint_publication_service();
  actor := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_proposal_id is null or p_proposal_revision_id is null or p_request_id is null
    or p_expected_review_version is null or p_expected_review_version < 0
    or p_action is null or p_action not in ('comment', 'investigate', 'revise', 'dismiss')
    or p_note is null or char_length(p_note) > 4000 or (p_action = 'comment' and btrim(p_note) = '') then
    raise exception 'Invalid improvement review.' using errcode = '22023';
  end if;

  select event.* into saved from internal.factory_improvement_review_events event
  where (event.workspace_id, event.factory_id, event.request_id) = (p_workspace_id, p_factory_id, p_request_id);
  if found then
    if (saved.proposal_id, saved.proposal_revision_id, saved.version - 1, saved.actor_member_id, saved.action, saved.note)
      is distinct from (p_proposal_id, p_proposal_revision_id, p_expected_review_version, actor, p_action, p_note) then
      raise exception 'The review request ID is already in use.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('event', internal.project_factory_improvement_review_event(saved), 'replay', true);
  end if;

  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select revision.id into latest_id from internal.factory_improvement_proposal_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.proposal_id) =
    (p_workspace_id, p_factory_id, p_proposal_id)
  order by revision.revision_number desc limit 1;
  if not found then raise exception 'Improvement proposal is unavailable.' using errcode = 'P0002'; end if;
  if latest_id <> p_proposal_revision_id then
    raise exception 'The proposal revision changed. Reload before reviewing.' using errcode = 'PT409';
  end if;

  select coalesce(max(event.version), 0) into version from internal.factory_improvement_review_events event
  where (event.workspace_id, event.factory_id, event.proposal_id, event.proposal_revision_id) =
    (p_workspace_id, p_factory_id, p_proposal_id, p_proposal_revision_id);
  if version <> p_expected_review_version or
    internal.factory_improvement_disposition(p_workspace_id, p_factory_id, p_proposal_id, p_proposal_revision_id) = 'dismissed' then
    raise exception 'The proposal review changed. Reload before reviewing.' using errcode = 'PT409';
  end if;

  insert into internal.factory_improvement_review_events(workspace_id, factory_id, proposal_id, proposal_revision_id,
    version, request_id, actor_member_id, action, note)
  values (p_workspace_id, p_factory_id, p_proposal_id, p_proposal_revision_id,
    version + 1, p_request_id, actor, p_action, p_note) returning * into saved;
  return jsonb_build_object('event', internal.project_factory_improvement_review_event(saved), 'replay', false);
end;
$$;

create function public.list_factory_improvement_workbench(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer default 24,
  p_after_proposal_id uuid default null, p_cohort_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.list_factory_improvement_workbench(p_workspace_id, p_factory_id, p_limit, p_after_proposal_id, p_cohort_id)
$$;

create function public.read_factory_improvement_workbench(
  p_workspace_id uuid, p_factory_id uuid, p_proposal_id uuid, p_revision_id uuid default null,
  p_before_event integer default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.read_factory_improvement_workbench(p_workspace_id, p_factory_id, p_proposal_id, p_revision_id, p_before_event)
$$;

revoke all on function
  internal.project_factory_improvement_review_event(internal.factory_improvement_review_events),
  internal.factory_improvement_disposition(uuid, uuid, uuid, uuid),
  internal.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid),
  internal.read_factory_improvement_workbench(uuid, uuid, uuid, uuid, integer),
  public.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid),
  public.read_factory_improvement_workbench(uuid, uuid, uuid, uuid, integer),
  public.save_factory_improvement_review_event(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function
  internal.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid),
  internal.read_factory_improvement_workbench(uuid, uuid, uuid, uuid, integer),
  public.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid),
  public.read_factory_improvement_workbench(uuid, uuid, uuid, uuid, integer) to authenticated;
grant execute on function public.save_factory_improvement_review_event(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text)
  to service_role;
