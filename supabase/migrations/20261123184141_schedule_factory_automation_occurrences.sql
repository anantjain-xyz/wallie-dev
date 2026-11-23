create table internal.factory_automation_schedule_cursors (
  workspace_id uuid not null,
  factory_id uuid not null,
  automation_id uuid not null,
  revision_id uuid not null,
  activated_at timestamptz not null,
  scanned_through timestamptz not null,
  next_due_at timestamptz,
  recheck_at timestamptz not null,
  cursor_version bigint not null default 0 check (cursor_version between 0 and 9007199254740991),
  resume_through timestamptz,
  last_resume_through timestamptz,
  last_resume_occurrence_at timestamptz,
  primary key (automation_id, revision_id),
  foreign key (workspace_id, factory_id, automation_id)
    references internal.factory_automations(workspace_id, factory_id, id) on delete cascade,
  foreign key (automation_id, revision_id)
    references internal.factory_automation_revisions(automation_id, id) on delete cascade,
  check (scanned_through >= activated_at),
  check (next_due_at is null or next_due_at > scanned_through),
  check (resume_through is null or resume_through >= scanned_through),
  check (last_resume_occurrence_at is null or last_resume_occurrence_at <= last_resume_through)
);
create index factory_automation_schedule_cursors_due_idx
  on internal.factory_automation_schedule_cursors(recheck_at, automation_id, revision_id);

alter table internal.factory_automation_schedule_cursors enable row level security;
revoke all on internal.factory_automation_schedule_cursors from public, anon, authenticated, service_role;

create function internal.sync_factory_automation_schedule_cursor()
returns trigger language plpgsql set search_path = '' as $$
declare changed_at timestamptz := clock_timestamp();
begin
  if new.published_revision_id is distinct from old.published_revision_id then
    insert into internal.factory_automation_schedule_cursors(
      workspace_id, factory_id, automation_id, revision_id, activated_at, scanned_through, recheck_at
    )
    select new.workspace_id, new.factory_id, new.id, revision.id, changed_at, changed_at, changed_at
    from internal.factory_automation_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.automation_id, revision.id) =
      (new.workspace_id, new.factory_id, new.id, new.published_revision_id)
      and revision.definition#>>'{trigger,kind}' = 'schedule';
  end if;

  if old.admission_paused and not new.admission_paused then
    update internal.factory_automation_schedule_cursors cursor_row
    set resume_through = changed_at, recheck_at = least(cursor_row.recheck_at, changed_at)
    where (cursor_row.automation_id, cursor_row.revision_id) = (new.id, new.published_revision_id);
  end if;
  return null;
end;
$$;
create trigger sync_factory_automation_schedule_cursor
  after update of published_revision_id, admission_paused on internal.factory_automations
  for each row execute function internal.sync_factory_automation_schedule_cursor();

-- Existing published schedules start from their exact publication, independent
-- of the worker's first observation. The catch-up window still bounds downtime.
insert into internal.factory_automation_schedule_cursors(
  workspace_id, factory_id, automation_id, revision_id, activated_at, scanned_through, recheck_at
)
select automation.workspace_id, automation.factory_id, automation.id, revision.id,
  coalesce(publication.created_at, statement_timestamp()), coalesce(publication.created_at, statement_timestamp()), statement_timestamp()
from internal.factory_automations automation
join internal.factory_automation_revisions revision
  on (revision.automation_id, revision.id) = (automation.id, automation.published_revision_id)
left join lateral (
  select audit.created_at from public.factory_audit_events audit
  where (audit.workspace_id, audit.factory_id, audit.action) =
    (automation.workspace_id, automation.factory_id, 'automation.published')
    and audit.detail @> jsonb_build_object('automationId', automation.id, 'publishedRevisionId', revision.id)
  order by audit.id desc limit 1
) publication on true
where automation.archived_at is null and revision.definition#>>'{trigger,kind}' = 'schedule';

create function public.list_due_factory_automation_schedules()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare snapshot_at timestamptz := statement_timestamp();
begin
  perform internal.assert_checkpoint_publication_service();
  return coalesce((
    select jsonb_agg(candidate.snapshot order by candidate.recheck_at, candidate.automation_id)
    from (
      select cursor_row.recheck_at, cursor_row.automation_id,
        jsonb_build_object(
          'workspaceId', rule.workspace_id, 'factoryId', rule.factory_id,
          'automationId', rule.id, 'revisionId', revision.id,
          'cursorVersion', cursor_row.cursor_version, 'admissionGeneration', rule.admission_generation,
          'scannedThrough', cursor_row.scanned_through,
          'through', coalesce(cursor_row.resume_through, snapshot_at),
          'cron', revision.definition#>>'{trigger,cron}', 'timeZone', revision.definition#>>'{trigger,timeZone}'
        ) as snapshot
      from internal.factory_automation_schedule_cursors cursor_row
      join internal.factory_automations rule on (rule.id, rule.published_revision_id) =
        (cursor_row.automation_id, cursor_row.revision_id)
      join internal.factory_automation_revisions revision
        on (revision.automation_id, revision.id) = (cursor_row.automation_id, cursor_row.revision_id)
      join public.factories factory on (factory.workspace_id, factory.id) = (rule.workspace_id, rule.factory_id)
      join public.workspaces workspace on workspace.id = rule.workspace_id
      where cursor_row.recheck_at <= snapshot_at
        and not rule.admission_paused and rule.archived_at is null
        and factory.status = 'active' and workspace.deletion_requested_at is null
      order by cursor_row.recheck_at, cursor_row.automation_id
      limit 4
    ) candidate
  ), '[]'::jsonb);
end;
$$;

create function public.commit_factory_automation_schedule(
  p_workspace_id uuid, p_factory_id uuid, p_automation_id uuid, p_revision_id uuid,
  p_expected_cursor_version bigint, p_expected_admission_generation bigint, p_plan jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  cursor_row internal.factory_automation_schedule_cursors;
  through_at timestamptz;
  occurrence_at timestamptz;
  planned_next_due_at timestamptz;
  occurrence_key text;
  tick_at timestamptz := statement_timestamp();
begin
  perform internal.assert_checkpoint_publication_service();
  if jsonb_typeof(p_plan) is distinct from 'object'
    or not (p_plan ?& array['through','occurrenceAt','nextDueAt'])
    or p_plan - array['through','occurrenceAt','nextDueAt'] <> '{}'::jsonb
    or jsonb_typeof(p_plan->'through') is distinct from 'string'
    or jsonb_typeof(p_plan->'occurrenceAt') not in ('string', 'null')
    or jsonb_typeof(p_plan->'nextDueAt') not in ('string', 'null') then
    raise exception 'Invalid automation schedule plan.' using errcode = '22023';
  end if;
  through_at := (p_plan->>'through')::timestamptz;
  occurrence_at := (p_plan->>'occurrenceAt')::timestamptz;
  planned_next_due_at := (p_plan->>'nextDueAt')::timestamptz;
  if not isfinite(through_at) or through_at > tick_at
    or (occurrence_at is not null and (
      not isfinite(occurrence_at) or occurrence_at > through_at
      or occurrence_at <= through_at - interval '24 hours'
      or occurrence_at <> date_trunc('minute', occurrence_at)))
    or (planned_next_due_at is not null and (
      not isfinite(planned_next_due_at) or planned_next_due_at <= through_at
      or planned_next_due_at <> date_trunc('minute', planned_next_due_at))) then
    raise exception 'Invalid automation schedule bounds.' using errcode = '22023';
  end if;

  perform 1 from public.workspaces workspace
  where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share nowait;
  if not found then return false; end if;
  perform 1 from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id)
    and factory.status = 'active' for share nowait;
  if not found then return false; end if;
  perform 1 from internal.factory_automations rule
  where (rule.workspace_id, rule.factory_id, rule.id, rule.published_revision_id, rule.admission_generation) =
    (p_workspace_id, p_factory_id, p_automation_id, p_revision_id, p_expected_admission_generation)
    and rule.archived_at is null and not rule.admission_paused for no key update nowait;
  if not found then return false; end if;
  select * into cursor_row from internal.factory_automation_schedule_cursors current
  where (current.automation_id, current.revision_id, current.cursor_version) =
    (p_automation_id, p_revision_id, p_expected_cursor_version) for update nowait;
  if not found or through_at < cursor_row.scanned_through
    or (cursor_row.resume_through is not null and cursor_row.resume_through <> through_at) then
    return false;
  end if;

  if occurrence_at is not null then
    if occurrence_at <= cursor_row.scanned_through then
      raise exception 'The scheduled occurrence was already scanned.' using errcode = '22023';
    end if;
    occurrence_key := to_char(occurrence_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    perform public.record_factory_automation_occurrence(
      p_workspace_id, p_factory_id, p_automation_id, p_revision_id, 'schedule', occurrence_key,
      jsonb_build_object('kind', 'schedule', 'scheduledFor', occurrence_key)
    );
  end if;

  update internal.factory_automation_schedule_cursors current
  set scanned_through = through_at, next_due_at = planned_next_due_at,
    recheck_at = case when planned_next_due_at is null then tick_at + interval '24 hours'
      else least(planned_next_due_at, tick_at + interval '24 hours') end,
    cursor_version = current.cursor_version + 1,
    resume_through = null,
    last_resume_through = coalesce(cursor_row.resume_through, current.last_resume_through),
    last_resume_occurrence_at = case when cursor_row.resume_through is not null then occurrence_at
      else current.last_resume_occurrence_at end
  where (current.automation_id, current.revision_id) = (p_automation_id, p_revision_id);
  return true;
exception when lock_not_available then
  return false;
end;
$$;

create function public.read_factory_automation_schedule_preview(
  p_workspace_id uuid, p_factory_id uuid, p_automation_id uuid, p_revision_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'asOf', statement_timestamp(), 'current', rule.published_revision_id is not distinct from revision.id,
    'archived', rule.archived_at is not null or factory.status <> 'active',
    'paused', rule.admission_paused, 'scannedThrough', cursor_row.scanned_through,
    'resumeThrough', cursor_row.resume_through, 'lastResumeThrough', cursor_row.last_resume_through,
    'lastResumeOccurrenceAt', cursor_row.last_resume_occurrence_at)
  from internal.factory_automations rule
  join public.factories factory on (factory.workspace_id, factory.id) = (rule.workspace_id, rule.factory_id)
  join internal.factory_automation_revisions revision
    on (revision.automation_id, revision.id) = (rule.id, p_revision_id)
  left join internal.factory_automation_schedule_cursors cursor_row
    on (cursor_row.automation_id, cursor_row.revision_id) = (rule.id, revision.id)
  where (rule.workspace_id, rule.factory_id, rule.id) = (p_workspace_id, p_factory_id, p_automation_id)
    and revision.definition#>>'{trigger,kind}' = 'schedule'
    and internal.can_manage_factory(p_workspace_id, p_factory_id)
$$;

revoke all on function internal.sync_factory_automation_schedule_cursor(),
  public.list_due_factory_automation_schedules(),
  public.commit_factory_automation_schedule(uuid, uuid, uuid, uuid, bigint, bigint, jsonb),
  public.read_factory_automation_schedule_preview(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_due_factory_automation_schedules(),
  public.commit_factory_automation_schedule(uuid, uuid, uuid, uuid, bigint, bigint, jsonb)
  to service_role;
grant execute on function public.read_factory_automation_schedule_preview(uuid, uuid, uuid, uuid)
  to authenticated;
