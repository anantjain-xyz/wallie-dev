begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.context_id(slot integer) returns uuid language sql immutable as $$
  select ('58000000-0000-4000-8000-' || lpad(slot::text,12,'0'))::uuid;
$$;
select public.set_git_continuity_release(true,revision,'Frozen run context fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into auth.users(id,email) values (pg_temp.context_id(1),'frozen-context-owner@example.test');
insert into public.workspaces(id,slug,name) values
  (pg_temp.context_id(2),'frozen-context-fixture','Frozen run context'),
  (pg_temp.context_id(3),'unrelated-context-fixture','Unrelated context');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
values (pg_temp.context_id(4),pg_temp.context_id(2),pg_temp.context_id(1),'human','owner');
create temp table context_factory as
select workspace_id,id from public.factories where workspace_id=pg_temp.context_id(2) and is_default;
insert into public.pipelines(id,workspace_id,factory_id,name,is_default)
select pg_temp.context_id(5),workspace_id,id,'Frozen context pipeline',true from context_factory;
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name)
values (pg_temp.context_id(6),pg_temp.context_id(5),pg_temp.context_id(2),1,'context-build','Build');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values (pg_temp.context_id(7),pg_temp.context_id(2),58000001,'https://github.test/installations/58000001',
  58000,'Organization','fixture','{"contents":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.context_id(8),workspace_id,id,pg_temp.context_id(7),58000001,'writer','fixture/writer',true,
  'https://github.test/fixture/writer','main' from context_factory;
select public.save_execution_policy(pg_temp.context_id(2),pg_temp.context_id(1),0,
  '{"version":1,"maxRepairAttempts":10,"maxExecutionMs":300000,"maxTotalTokens":null,"maxCostUsd":null}');
create temp table context_grant as
select approved.* from context_factory factory join public.execution_policies policy using (workspace_id)
cross join lateral public.create_service_principal(factory.workspace_id,factory.id,pg_temp.context_id(1),
  'Frozen context fixture','frozen-context-fixture') principal
cross join lateral public.approve_factory_execution_grant(factory.workspace_id,factory.id,pg_temp.context_id(1),principal.id,
  pg_temp.context_id(8),'{}'::uuid[],'{}'::text[],policy.current_revision_id,pg_temp.context_id(4),
  clock_timestamp()+interval '1 hour',0) approved;
with definition as (
  select workspace_id,factory_id,jsonb_build_object(
    'schemaVersion',1,'kind','serial','pipelineId',pg_temp.context_id(5),'repositoryId',github_repository_id,
    'executionPolicyRevisionId',execution_policy_revision_id,'executionGrant',jsonb_build_object('id',id,'version',version),
    'agent',jsonb_build_object('provider','codex','model','gpt-5.5','maxRetries',8),'sandboxProvider','e2b',
    'toolIds','[]'::jsonb,'stages',jsonb_build_array(jsonb_build_object('id',pg_temp.context_id(6),'slug','context-build','name','Build'))
  )::text as body from context_grant
), revision as (
  insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
    select workspace_id,factory_id,1,body,encode(sha256(convert_to(body,'UTF8')),'hex'),pg_temp.context_id(1) from definition
    returning id,workspace_id,factory_id,created_by
)
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,1,created_by from revision;

create function pg_temp.start_attempt(p_job_id uuid,p_attempt integer) returns uuid language plpgsql as $$
declare owner public.sessions;
begin
  select session.* into strict owner from public.sessions session join public.agent_jobs job on job.session_id=session.id
  where job.id=p_job_id;
  update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()),
    status='running',attempt_count=p_attempt,scheduled_at=null where id=p_job_id;
  return public.start_session_job_attempt(p_job_id,p_attempt,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/frozen-context-' || p_job_id::text);
end;
$$;
create function pg_temp.initial_attempt(p_label text) returns table(session_id uuid,job_id uuid,run_id uuid)
language sql as $$
  select queued.session_id,queued.job_id,pg_temp.start_attempt(queued.job_id,1)
  from public.create_session_with_first_job(pg_temp.context_id(2),pg_temp.context_id(4),p_label,'Frozen context fixture',
    'codex','gpt-5.5',session_github_repository_id=>pg_temp.context_id(8)) queued;
$$;
create function pg_temp.manifest() returns jsonb language sql immutable as $$
  select jsonb_build_object('version',1,
    'required',jsonb_build_array(jsonb_build_object('key','predecessor/stage-1','sha256',repeat('a',64),'utf8Bytes',20)),
    'documents',jsonb_build_array(jsonb_build_object('sourceId',pg_temp.context_id(20),
      'revisionId',pg_temp.context_id(21),'status','selected','reason','exact_revision','filePath','docs/synthetic.md',
      'upstreamRevision',repeat('a',40),'contentSha256',repeat('b',64),'contentBytes',6,'stale',false,
      'sha256',repeat('c',64),'utf8Bytes',40),jsonb_build_object('sourceId',pg_temp.context_id(22),
      'revisionId',pg_temp.context_id(23),'status','excluded','reason','context_budget')),
    'conversation',jsonb_build_object('throughSequence',4,'olderOmitted',2,'messages',jsonb_build_array(
      jsonb_build_object('sequence',3,'sha256',repeat('d',64),'utf8Bytes',10),
      jsonb_build_object('sequence',4,'reason','context_budget'))),
    'budget',jsonb_build_object('maxUtf8Bytes',131072,'maxEstimatedTokens',32768,'usedUtf8Bytes',70,'estimatedTokens',70));
$$;
create function pg_temp.pin_context(p_job uuid,p_run uuid,p_attempt integer,p_value jsonb,p_origin uuid default null)
returns public.session_run_context_manifests language sql as $$
  select public.pin_factory_run_context(pg_temp.context_id(2),p_job,p_run,p_attempt,p_value,p_origin);
$$;
create function pg_temp.context_origin(p_job uuid,p_run uuid,p_attempt integer)
returns table(status text,origin_run_id uuid,manifest jsonb) language sql as $$
  select * from public.read_factory_run_context_origin(pg_temp.context_id(2),p_job,p_run,p_attempt);
$$;
create function pg_temp.explicit_retry(p_session uuid,p_previous uuid)
returns table(job_id uuid,run_id uuid) language sql as $$
  select queued.job_id,pg_temp.start_attempt(queued.job_id,1)
  from public.enqueue_session_retry_with_checkpoint(p_session,pg_temp.context_id(2),pg_temp.context_id(6),
    pg_temp.context_id(4),p_previous,'codex','gpt-5.5','project') queued;
$$;

-- The memory lifecycle is exercised by its own suite. Seed exact approved
-- rows here so this suite can exercise the normal locked pin and replay RPC.
insert into public.factory_memories(id, workspace_id, factory_id, title, source_session_id,
  source_artifact_id, source_artifact_version, source_run_id, source_attempt_count,
  source_commit_sha, source_content_sha256)
select pg_temp.context_id(slot), factory.workspace_id, factory.id, 'Pin memory fixture',
  pg_temp.context_id(slot + 1), pg_temp.context_id(slot + 2), 1, pg_temp.context_id(slot + 3), 1,
  repeat('a',40), repeat('b',64)
from (values (101, pg_temp.context_id(2)), (201, pg_temp.context_id(3))) scope(slot, workspace_id)
join public.factories factory on factory.workspace_id = scope.workspace_id and factory.is_default;
insert into public.factory_memory_revisions(id, workspace_id, factory_id, memory_id, revision_number, content_sha256)
select pg_temp.context_id(slot + 4), memory.workspace_id, memory.factory_id, memory.id, 1,
  encode(sha256(convert_to('é','UTF8')),'hex')
from (values (101), (201)) fixture(slot)
join public.factory_memories memory on memory.id = pg_temp.context_id(slot);
insert into public.factory_memory_revision_bodies(workspace_id, factory_id, memory_id, revision_id, body_md)
select revision.workspace_id, revision.factory_id, revision.memory_id, revision.id, 'é'
from public.factory_memory_revisions revision where id in (pg_temp.context_id(105),pg_temp.context_id(205));
insert into public.factory_memory_review_events(id,workspace_id,factory_id,memory_id,revision_id,actor_member_id,action)
select pg_temp.context_id(slot + 5), revision.workspace_id, revision.factory_id, revision.memory_id, revision.id,
  pg_temp.context_id(4), 'approved'
from (values (101), (201)) fixture(slot)
join public.factory_memory_revisions revision on revision.id = pg_temp.context_id(slot + 4);
update public.factory_memories memory
set current_revision_id = pg_temp.context_id(slot + 4), current_approval_id = pg_temp.context_id(slot + 5)
from (values (101), (201)) fixture(slot) where memory.id = pg_temp.context_id(slot);

create function pg_temp.memory_manifest(slot integer) returns jsonb language sql immutable as $$
  select pg_temp.manifest() || jsonb_build_object(
    'version',2,'memories',jsonb_build_array(jsonb_build_object('memoryId',pg_temp.context_id(slot),
      'revisionId',pg_temp.context_id(slot+4),'approvalId',pg_temp.context_id(slot+5),
      'status','selected','sha256',encode(sha256(convert_to('é','UTF8')),'hex'),'utf8Bytes',2)),
    'budget',pg_temp.manifest()->'budget' || '{"usedUtf8Bytes":72,"estimatedTokens":72}'::jsonb);
$$;
create temp table memory_attempt as select * from pg_temp.initial_attempt('Freeze exact memory');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,pg_temp.memory_manifest(201))
  from memory_attempt$$,'PT409',null,'memory from a foreign factory cannot enter a run manifest');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,
  jsonb_set(pg_temp.memory_manifest(101),'{memories,0,sha256}',to_jsonb(repeat('f',64))))
  from memory_attempt$$,'PT409',null,'memory digest must match exact admitted bytes');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,
  jsonb_set(pg_temp.memory_manifest(101),'{memories,0,body}','"private"'))
  from memory_attempt$$,'23514',null,'v2 stores no raw memory body');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,
  jsonb_set(pg_temp.memory_manifest(101),'{budget,usedUtf8Bytes}','70'))
  from memory_attempt$$,'23514',null,'selected memory consumes the exact UTF-8 budget');
create temp table memory_manifest_receipt as select receipt.* from memory_attempt attempt
cross join lateral pg_temp.pin_context(attempt.job_id,attempt.run_id,1,pg_temp.memory_manifest(101)) receipt;
select is((select manifest from memory_manifest_receipt),pg_temp.memory_manifest(101),
  'the locked pin freezes an exact same-factory approved memory revision');
update public.factory_memories set current_revision_id = null, current_approval_id = null
where id = pg_temp.context_id(101);
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,manifest,run_id)
  from memory_manifest_receipt$$,'PT409',null,'same-run replay denies a memory invalidated after pinning');
select ok((select pinned.manifest = retained.manifest and pinned.manifest_sha256 = retained.manifest_sha256
  from public.session_run_context_manifests pinned join memory_manifest_receipt retained using (run_id)),
  'memory invalidation preserves historical manifest identity and digest');

create temp table main_attempt as select * from pg_temp.initial_attempt('Freeze one context selection');
select is((select status from main_attempt attempt cross join lateral pg_temp.context_origin(attempt.job_id,attempt.run_id,1)),
  'fresh','first exact running attempt has no retry origin');
select throws_ok($$select * from main_attempt attempt cross join lateral public.read_factory_run_context_origin(
  pg_temp.context_id(3),attempt.job_id,attempt.run_id,1)$$,'42501',null,'another workspace cannot acquire this attempt');
select throws_ok($$select * from main_attempt attempt cross join lateral pg_temp.context_origin(attempt.job_id,attempt.run_id,2)$$,
  '42501',null,'a stale attempt number cannot acquire this run');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,jsonb_set(pg_temp.manifest(),'{documents,0,body}','"private"'))
  from main_attempt$$,'23514',null,'selected receipt cannot include raw document content');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,jsonb_set(pg_temp.manifest(),'{budget,usedUtf8Bytes}','71'))
  from main_attempt$$,'23514',null,'usage must equal the selected UTF-8 byte count');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,jsonb_set(pg_temp.manifest(),'{conversation,messages,1,sequence}','3'))
  from main_attempt$$,'23514',null,'frozen conversation sequences are distinct and ordered');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,jsonb_set(pg_temp.manifest(),'{conversation,olderOmitted}','5'))
  from main_attempt$$,'23514',null,'older conversation omissions cannot overflow the captured sequence range');
create temp table frozen as select receipt.* from main_attempt attempt cross join lateral
  pg_temp.pin_context(attempt.job_id,attempt.run_id,1,pg_temp.manifest()) receipt;
select ok((select manifest=pg_temp.manifest() and origin_run_id is null
  and manifest_sha256=encode(sha256(convert_to(manifest::text,'UTF8')),'hex') from frozen),
  'the initial attempt durably freezes exact metadata and hashes the JSON payload');
select ok((select replay.status='replay' and replay.origin_run_id=frozen.run_id and replay.manifest=frozen.manifest
  from frozen cross join lateral pg_temp.context_origin(frozen.job_id,frozen.run_id,1) replay),
  're-reading a pinned current attempt exposes its own original selection');
select is((select (pg_temp.pin_context(job_id,run_id,1,manifest,run_id)).created_at from frozen),
  (select created_at from frozen),'an exact self replay is safe and leaves stored ancestry unchanged');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,1,jsonb_set(manifest,'{required,0,sha256}',to_jsonb(repeat('e',64))))
  from frozen$$,'PT409',null,'a later input digest cannot rewrite an already admitted attempt');
select throws_ok($$update public.session_run_context_manifests set manifest='{}'$$,'23514',null,'frozen rows reject direct updates');

select is((select public.fail_session_job_attempt(job_id,1,'First validation failed',true,8,run_id) from main_attempt),
  'queued','the failed first attempt schedules automatic retry');
create temp table main_startup_failure as select job_id,pg_temp.start_attempt(job_id,2) as run_id from main_attempt;
select is((select public.fail_session_job_attempt(job_id,2,'Sandbox never dispatched',true,8,run_id) from main_startup_failure),
  'queued','a transient startup failure can be retried');
create temp table main_replay as select job_id,pg_temp.start_attempt(job_id,3) as run_id from main_attempt;
select ok((select replay.status='replay' and replay.origin_run_id=frozen.run_id and replay.manifest=frozen.manifest
  from main_replay active cross join frozen cross join lateral pg_temp.context_origin(active.job_id,active.run_id,3) replay),
  'automatic retry skips an intermediate startup failure and reuses the older frozen attempt');
select throws_ok($$select pg_temp.pin_context(active.job_id,active.run_id,3,
  jsonb_set(frozen.manifest,'{documents,0,revisionId}',to_jsonb(pg_temp.context_id(24))),frozen.run_id)
  from main_replay active cross join frozen$$,'23514',null,'retry cannot substitute a later document revision');
create temp table frozen_replay as select pinned.* from main_replay active cross join frozen cross join lateral
  pg_temp.pin_context(active.job_id,active.run_id,3,frozen.manifest,frozen.run_id) pinned;
select is((select manifest_sha256 from frozen_replay),(select manifest_sha256 from frozen),
  'the replay preserves the first attempt digest byte for byte');
select is((select public.fail_session_job_attempt(job_id,3,'Manual retry next',false,8,run_id) from main_replay),
  'error','the explicit retry can name the exact terminal attempt');
create temp table manual_retry as select retry.* from main_attempt first cross join main_replay past cross join lateral
  pg_temp.explicit_retry(first.session_id,past.run_id) retry;
select is((select count(*) from public.session_retry_checkpoint_jobs binding join manual_retry retry using(job_id)),
  0::bigint,'the explicit context binding does not require a Git retry checkpoint');
select ok((select replay.status='replay' and replay.origin_run_id=previous.run_id
  from manual_retry active cross join frozen_replay previous cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1) replay),
  'manual Retry replays the exact run selected by the operator');
select is((select public.fail_session_job_attempt(job_id,1,'Retry launch unavailable',true,8,run_id) from manual_retry),
  'queued','a pre-dispatch manual retry failure stays in its queued lineage');
create temp table manual_same_job as select job_id,pg_temp.start_attempt(job_id,2) as run_id from manual_retry;
select ok((select replay.status='replay' and replay.origin_run_id=previous.run_id
  from manual_same_job active cross join frozen_replay previous cross join lateral pg_temp.context_origin(active.job_id,active.run_id,2) replay),
  'an automatic retry of a never-frozen manual job retains its explicit origin');
select is((select public.fail_session_job_attempt(job_id,2,'Retry launch still unavailable',false,8,run_id) from manual_same_job),
  'error','a second manual retry can target the unfrozen terminal attempt');
create temp table explicit_chain as select retry.* from main_attempt first cross join manual_same_job past cross join lateral
  pg_temp.explicit_retry(first.session_id,past.run_id) retry;
select ok((select replay.status='replay' and replay.origin_run_id=previous.run_id
  from explicit_chain active cross join frozen_replay previous cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1) replay),
  'manual Retry of an incomplete manual attempt carries the originally selected frozen context');

create temp table dispatched_legacy as select * from pg_temp.initial_attempt('Already dispatched without a context manifest');
select public.pin_session_job_git_input(job_id,1,run_id,pg_temp.context_id(8),'main',repeat('b',40)) from dispatched_legacy;
select ok(public.pin_session_attempt_manifest(job_id,run_id,1,repeat('a',64),24,3,repeat('b',40),'[]','node',7,'high',null),
  'the legacy attempt has durable dispatch evidence but no context freeze') from dispatched_legacy;
select is((select public.fail_session_job_attempt(job_id,1,'Legacy agent failed after dispatch',true,8,run_id) from dispatched_legacy),
  'queued','an already dispatched legacy attempt may have queued a retry');
create temp table legacy_automatic as select job_id,pg_temp.start_attempt(job_id,2) as run_id from dispatched_legacy;
select ok((select replay.status='missing' and replay.origin_run_id is null and replay.manifest is null
  from legacy_automatic active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,2) replay),
  'an exact legacy dispatch without context fails closed instead of selecting live data');
select throws_ok($$select pg_temp.pin_context(job_id,run_id,2,pg_temp.manifest()) from legacy_automatic$$,
  'PT409',null,'a legacy retry cannot pin replacement inputs');
select is((select public.fail_session_job_attempt(job_id,2,'Missing original context',false,8,run_id) from legacy_automatic),
  'error','missing replay remains terminal');
create temp table missing_chain as select retry.* from dispatched_legacy first cross join legacy_automatic past cross join lateral
  pg_temp.explicit_retry(first.session_id,past.run_id) retry;
select is((select status from missing_chain active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1)),
  'missing','a manual retry chain cannot turn earlier missing dispatched evidence into fresh context');

create temp table manual_startup_failure as select * from pg_temp.initial_attempt('Initial sandbox could not acquire');
select is((select public.fail_session_job_attempt(job_id,1,'Sandbox never dispatched',false,8,run_id)
  from manual_startup_failure),'error','the startup-only first job can become terminal');
create temp table manual_first_freeze as select retry.* from manual_startup_failure past cross join lateral
  pg_temp.explicit_retry(past.session_id,past.run_id) retry;
select ok((select receipt.status='fresh' and receipt.origin_run_id is null and receipt.manifest is null
  from manual_first_freeze active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1) receipt),
  'operator Retry after a failed initial startup can make its first context selection');
select ok((select (pg_temp.pin_context(job_id,run_id,1,pg_temp.manifest())).origin_run_id is null
  from manual_first_freeze),'the first real freeze has no historical context origin');

create temp table startup_only as select * from pg_temp.initial_attempt('Never dispatched and safe to freeze next');
select is((select public.fail_session_job_attempt(job_id,1,'Acquisition never completed',true,8,run_id) from startup_only),
  'queued','a first startup-only failure is eligible to retry');
create temp table startup_next as select job_id,pg_temp.start_attempt(job_id,2) as run_id from startup_only;
select is((select status from startup_next active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,2)),
  'fresh','no context or dispatch existed, so automatic retry may make its first selection');
select public.pin_session_job_git_input(job_id,2,run_id,pg_temp.context_id(8),'main',repeat('c',40)) from startup_next;
select ok(public.pin_session_attempt_manifest(job_id,run_id,2,repeat('b',64),24,3,repeat('c',40),'[]','node',7,'high',null),
  'a later attempt of the startup-only job eventually reaches dispatch') from startup_next;
select is((select public.fail_session_job_attempt(job_id,2,'Unowned generation terminal',false,8,run_id) from startup_next),
  'error','a later producer can enqueue for the rejected stage');
create temp table retry_old_startup as select retry.* from startup_only past cross join lateral
  pg_temp.explicit_retry(past.session_id,past.run_id) retry;
select is((select status from retry_old_startup active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1)),
  'missing','selecting old startup history cannot bypass later dispatch of the same original job');
select is((select public.fail_session_job_attempt(job_id,1,'Exact original context unavailable',false,8,run_id) from retry_old_startup),
  'error','a missing old-startup retry leaves the stage eligible for a separate system generation');
create temp table linear_reroute as select queued.job_id,pg_temp.start_attempt(queued.job_id,1) as run_id
from startup_only first cross join lateral public.enqueue_session_job_with_run(first.session_id,pg_temp.context_id(2),
  pg_temp.context_id(6),null,'manual_retry','codex','gpt-5.5','project') queued;
select is((select status from linear_reroute active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1)),
  'fresh','system-routed Linear rework creates a new generation without inventing a manual origin');
select is((select public.fail_session_job_attempt(job_id,1,'System generation terminal',false,8,run_id) from linear_reroute),
  'error','the explicit operator still needs a binding');
create temp table unbound_manual as select queued.job_id,pg_temp.start_attempt(queued.job_id,1) as run_id
from startup_only first cross join lateral public.enqueue_session_job_with_run(first.session_id,pg_temp.context_id(2),
  pg_temp.context_id(6),pg_temp.context_id(4),'manual_retry','codex','gpt-5.5','project') queued;
select is((select status from unbound_manual active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1)),
  'missing','an authenticated manual retry without an exact binding cannot choose live inputs');
select is((select public.fail_session_job_attempt(job_id,1,'Unbound manual context',false,8,run_id) from unbound_manual),
  'error','a user can attempt another Retry after the unbound run fails');
create temp table retry_unbound_manual as select retry.* from startup_only first cross join unbound_manual past cross join lateral
  pg_temp.explicit_retry(first.session_id,past.run_id) retry;
select is((select status from retry_unbound_manual active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1)),
  'missing','retrying an unbound manual run still cannot choose fresh context');

select ok(not has_table_privilege('authenticated','public.session_run_context_manifests','SELECT')
  and not has_table_privilege('service_role','public.session_run_context_manifests','INSERT')
  and not has_function_privilege('authenticated','public.read_factory_run_context_origin(uuid,uuid,uuid,integer)','EXECUTE'),
  'context history and provenance RPCs are service-only and cannot be forged directly');
select public.revoke_factory_execution_grant(workspace_id,factory_id,pg_temp.context_id(1),id,version,'Revoked fixture') from context_grant;
select throws_ok($$select * from explicit_chain active cross join lateral pg_temp.context_origin(active.job_id,active.run_id,1)$$,
  '42501',null,'a current grant is checked again before any replay');
select throws_ok($$update internal.session_context_manual_retry_origins set origin_run_id=gen_random_uuid()$$,
  '23514',null,'an existing manual binding cannot be rewritten');
select lives_ok($$delete from public.sessions where id=(select session_id from main_attempt)$$,
  'removing an owning session cascades immutable context and retry bindings');
select is((select count(*) from internal.session_context_manual_retry_origins where session_id=(select session_id from main_attempt)),
  0::bigint,'deleted sessions leave no retry binding');

select * from finish();
rollback;
