begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 66110000
\ir fixtures/factory_automation_occurrences.psql

select ok(has_function_privilege('service_role', 'public.list_due_factory_automation_schedules()', 'execute')
  and not has_function_privilege('authenticated', 'public.list_due_factory_automation_schedules()', 'execute')
  and not has_function_privilege('authenticated',
    'public.commit_factory_automation_schedule(uuid,uuid,uuid,uuid,bigint,bigint,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.read_factory_automation_schedule_preview(uuid,uuid,uuid,uuid)', 'execute'),
  'schedule producer, commit, and preview have separate RPC permissions');

select ok(cursor_row.activated_at = cursor_row.scanned_through and cursor_row.cursor_version = 0
  and cursor_row.revision_id = rule.revision_id, 'publishing a schedule initializes an exact cursor immediately')
from internal.factory_automation_schedule_cursors cursor_row join automation_occurrence_rule rule
on (cursor_row.automation_id, cursor_row.revision_id) = (rule.automation_id, rule.revision_id);

grant select on automation_occurrence_rule to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok(public.read_factory_automation_schedule_preview(workspace_id, factory_id, automation_id, revision_id)->>'current' = 'true',
  'the manager can read the exact published preview state') from automation_occurrence_rule;
select set_config('request.jwt.claim.sub', pg_temp.op651_id(2)::text, true);
select is(public.read_factory_automation_schedule_preview(workspace_id, factory_id, automation_id, revision_id), null::jsonb,
  'an ordinary workspace member cannot read schedule preview state') from automation_occurrence_rule;
reset role;
set local request.jwt.claim.role = 'service_role';
select set_config('request.jwt.claim.sub', pg_temp.op651_id(1)::text, true);

-- Restore a prior publication checkpoint to exercise a worker returning after downtime.
create temp table schedule_clock as
select date_trunc('minute', statement_timestamp()) - interval '15 minutes' as first_through,
  date_trunc('minute', statement_timestamp()) - interval '16 minutes' as first_occurrence,
  date_trunc('minute', statement_timestamp()) - interval '1 minute' as resume_occurrence,
  date_trunc('minute', statement_timestamp()) + interval '2 minutes' as next_due;
update internal.factory_automation_schedule_cursors cursor_row
set activated_at = clock.first_through - interval '2 hours',
  scanned_through = clock.first_through - interval '2 hours',
  recheck_at = clock.first_through - interval '1 hour'
from schedule_clock clock, automation_occurrence_rule rule
where (cursor_row.automation_id, cursor_row.revision_id) = (rule.automation_id, rule.revision_id);

select ok(public.list_due_factory_automation_schedules() @> jsonb_build_array(
  jsonb_build_object('automationId', automation_id, 'revisionId', revision_id, 'cursorVersion', 0,
    'admissionGeneration', 0)), 'worker selection includes the exact due cursor and admission generation')
from automation_occurrence_rule;

create function pg_temp.commit_test_automation_schedule(
  p_version bigint, p_generation bigint, p_through timestamptz, p_occurrence timestamptz, p_next timestamptz
) returns boolean language sql as $$
  select public.commit_factory_automation_schedule(rule.workspace_id, rule.factory_id, rule.automation_id,
    rule.revision_id, p_version, p_generation,
    jsonb_build_object('through', p_through, 'occurrenceAt', p_occurrence, 'nextDueAt', p_next))
  from automation_occurrence_rule rule
$$;
select is(pg_temp.commit_test_automation_schedule(0, 0, first_through, first_occurrence, next_due), true,
  'committing one schedule plan records the occurrence and advances its cursor') from schedule_clock;
select is(pg_temp.commit_test_automation_schedule(0, 0, first_through, first_occurrence, next_due), false,
  'a second or restarted worker with the same snapshot cannot record the occurrence again') from schedule_clock;
select ok(cursor_row.cursor_version = 1 and cursor_row.scanned_through = clock.first_through
  and count(occurrence.id) = 1 and bool_and(occurrence.source_namespace = 'schedule'
    and occurrence.source_key = to_char(clock.first_occurrence at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    and occurrence.event->>'scheduledFor' = occurrence.source_key),
  'cursor and single pending occurrence retain the canonical UTC identity')
from schedule_clock clock cross join automation_occurrence_rule rule
join internal.factory_automation_schedule_cursors cursor_row
  on (cursor_row.automation_id, cursor_row.revision_id) = (rule.automation_id, rule.revision_id)
join internal.factory_automation_occurrences occurrence on occurrence.automation_id = rule.automation_id
group by cursor_row.cursor_version, cursor_row.scanned_through, clock.first_through;
select is(public.admit_next_factory_automation_occurrence()->>'status', 'admitted',
  'the existing occurrence worker admits the scheduled tick through common session creation');

select is(pg_temp.configure_test_automation(0, true, 1)->>'generation', '1', 'operator pauses the schedule');
select is(pg_temp.commit_test_automation_schedule(1, 0, first_through, null, next_due), false,
  'an in-flight worker cannot advance a cursor or admit a tick after pause') from schedule_clock;
select ok(not (public.list_due_factory_automation_schedules() @> jsonb_build_array(
  jsonb_build_object('automationId', automation_id))), 'paused schedules are absent from worker selection')
from automation_occurrence_rule;

select is(pg_temp.configure_test_automation(1, false, 1)->>'generation', '2', 'operator resumes the exact rule');
create temp table resumed_schedule_snapshot as
select candidate->>'through' as through_at
from jsonb_array_elements(public.list_due_factory_automation_schedules()) candidate
join automation_occurrence_rule rule on candidate->>'automationId' = rule.automation_id::text;
select is(pg_temp.commit_test_automation_schedule(1, 2, snapshot.through_at::timestamptz,
  clock.resume_occurrence, clock.next_due), true,
  'a resumed worker commits against the frozen resume cutoff')
from resumed_schedule_snapshot snapshot cross join schedule_clock clock;
select ok(cursor_row.resume_through is null and cursor_row.last_resume_through = snapshot.through_at::timestamptz
  and cursor_row.last_resume_occurrence_at = clock.resume_occurrence,
  'the cursor preserves the exact missed occurrence selected at resume')
from resumed_schedule_snapshot snapshot cross join schedule_clock clock
cross join automation_occurrence_rule rule join internal.factory_automation_schedule_cursors cursor_row
  on (cursor_row.automation_id, cursor_row.revision_id) = (rule.automation_id, rule.revision_id);

create temp table revised_schedule as
select (public.save_factory_automation_draft(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id,
  jsonb_set(pg_temp.dry_run_definition('schedule'), '{trigger,timeZone}', '"America/New_York"'))->>'draftRevisionId')::uuid as revision_id
from automation_occurrence_rule;
select public.publish_factory_automation(rule.workspace_id, rule.factory_id, pg_temp.op651_id(1),
  rule.automation_id, revised.revision_id)
from automation_occurrence_rule rule cross join revised_schedule revised;
select ok(cursor_row.cursor_version = 0 and cursor_row.scanned_through = cursor_row.activated_at
  and cursor_row.scanned_through > clock.resume_occurrence,
  'a timezone change starts the replacement revision at publication without replaying old ticks')
from revised_schedule revised cross join schedule_clock clock
join internal.factory_automation_schedule_cursors cursor_row on cursor_row.revision_id = revised.revision_id;
select is(pg_temp.commit_test_automation_schedule(2, 2, clock.first_through, null, clock.next_due), false,
  'a cursor snapshot from the prior timezone cannot advance the replacement revision')
from schedule_clock clock;

select * from finish();
rollback;
