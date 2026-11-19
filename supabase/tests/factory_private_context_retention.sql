begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.retention_id(slot integer) returns uuid language sql immutable as $$
  select ('58800000-0010-4000-8000-' || lpad(slot::text, 12, '0'))::uuid;
$$;

insert into auth.users(id,email) values (pg_temp.retention_id(1),'context-retention@example.test');
insert into public.workspaces(id,slug,name) values
  (pg_temp.retention_id(2),'context-retention-fixture','Context retention fixture'),
  (pg_temp.retention_id(3),'context-retention-sibling','Unrelated workspace');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
values (pg_temp.retention_id(4),pg_temp.retention_id(2),pg_temp.retention_id(1),'human','owner');
create temp table retention_factories as
select workspace_id, id from public.factories
where is_default and workspace_id in (pg_temp.retention_id(2),pg_temp.retention_id(3));

insert into public.factory_context_sources(id,workspace_id,factory_id,repository_id,github_installation_id,
  upstream_repository_id,grant_id,grant_version,file_path)
select pg_temp.retention_id(slot), factory.workspace_id, factory.id, pg_temp.retention_id(10),
  pg_temp.retention_id(11), 58801, pg_temp.retention_id(12), 1, 'notes.md'
from (values (20, pg_temp.retention_id(2)), (30, pg_temp.retention_id(3))) item(slot,workspace_id)
join retention_factories factory using (workspace_id);
insert into public.factory_context_source_revisions(id,workspace_id,factory_id,source_id,upstream_revision,
  upstream_updated_at,media_type,content,content_bytes,content_sha256,created_at)
select pg_temp.retention_id(slot), source.workspace_id, source.factory_id, source.id,
  repeat(commit_letter, 40), clock_timestamp() - interval '30 days', 'text/markdown', body,
  octet_length(body), encode(sha256(convert_to(body,'UTF8')),'hex'), clock_timestamp() - interval '30 days'
from (values
  (21,20,'a','Old private context fixture'), (22,20,'b','Current document fixture'),
  (31,30,'c','Other workspace private fixture'), (32,30,'d','Other workspace current document')
) item(slot,source_slot,commit_letter,body)
join public.factory_context_sources source on source.id = pg_temp.retention_id(source_slot);
update public.factory_context_sources source
set status = 'synced', current_revision_id = revision.id, upstream_revision = revision.upstream_revision,
  upstream_updated_at = revision.upstream_updated_at, last_successful_sync_at = clock_timestamp()
from public.factory_context_source_revisions revision
where revision.source_id = source.id and revision.id in (pg_temp.retention_id(22),pg_temp.retention_id(32));

select is((public.save_workspace_run_retention(pg_temp.retention_id(2),pg_temp.retention_id(1),
  p_context_days => 7)).context_days,7,'owner opts into historical context retention independently');
select lives_ok($$select * from public.mark_expired_workspace_run_content()$$,
  'the shared worker sweep runs a context-only policy');
select ok((select content is null and content_purged_at is not null
  and content_bytes = octet_length('Old private context fixture')
  and content_sha256 = encode(sha256(convert_to('Old private context fixture','UTF8')),'hex')
  from public.factory_context_source_revisions where id = pg_temp.retention_id(21)),
  'old body is erased while exact digest and size remain');
select is((select content from public.factory_context_source_revisions where id = pg_temp.retention_id(22)),
  'Current document fixture','the current revision remains available even when it is older than the policy');
select is((select content from public.factory_context_source_revisions where id = pg_temp.retention_id(31)),
  'Other workspace private fixture','an unrelated workspace with no policy retains its historical body');
select ok(has_column_privilege('authenticated','public.factory_context_source_revisions','content_purged_at','SELECT')
  and not has_column_privilege('authenticated','public.factory_context_source_revisions','content','SELECT'),
  'historical inspection can name the removal time without granting the body');

select is((public.delete_factory_context_source(pg_temp.retention_id(2),
    (select id from retention_factories where workspace_id = pg_temp.retention_id(2)),
    pg_temp.retention_id(1),pg_temp.retention_id(20))).status,
  'deleted','explicit removal tombstones the source');
select ok((select count(*) = 2 and bool_and(content is null and content_purged_at is not null)
  from public.factory_context_source_revisions where source_id = pg_temp.retention_id(20)),
  'explicit removal erases old and current bytes without deleting revision history');
create temp table deletion_receipt as select deleted_at
from public.factory_context_sources where id = pg_temp.retention_id(20);
select is((public.delete_factory_context_source(pg_temp.retention_id(2),
    (select id from retention_factories where workspace_id = pg_temp.retention_id(2)),
    pg_temp.retention_id(1),pg_temp.retention_id(20))).deleted_at,
  (select deleted_at from deletion_receipt),'repeating source removal preserves the original deletion time');

insert into public.factory_memories(id,workspace_id,factory_id,title,source_session_id,source_artifact_id,
  source_artifact_version,source_run_id,source_attempt_count,source_commit_sha,source_content_sha256)
select pg_temp.retention_id(50),workspace_id,id,'Bounded memory',
  pg_temp.retention_id(51),pg_temp.retention_id(52),1,pg_temp.retention_id(53),1,repeat('a',40),repeat('b',64)
from retention_factories where workspace_id = pg_temp.retention_id(2);
insert into public.factory_memory_revisions(id,workspace_id,factory_id,memory_id,revision_number,content_sha256,expires_at)
select pg_temp.retention_id(slot),memory.workspace_id,memory.factory_id,memory.id,revision_number,
  encode(sha256(convert_to('Memory fixture body','UTF8')),'hex'),clock_timestamp()+offset_time
from (values (60,1,interval '-1 hour'),(61,2,interval '1 hour')) item(slot,revision_number,offset_time)
cross join public.factory_memories memory where memory.id = pg_temp.retention_id(50);
insert into public.factory_memory_revision_bodies(workspace_id,factory_id,memory_id,revision_id,body_md)
select workspace_id,factory_id,memory_id,id,'Memory fixture body'
from public.factory_memory_revisions where id in (pg_temp.retention_id(60),pg_temp.retention_id(61));
select is(public.purge_expired_factory_memory_bodies(),1,'the expiry sweep purges the exact elapsed revision');
select ok(exists (select 1 from public.factory_memory_revisions where id = pg_temp.retention_id(60))
  and not exists (select 1 from public.factory_memory_revision_bodies where revision_id=pg_temp.retention_id(60)),
  'memory expiry retains provenance and erases raw text');
select ok(exists (select 1 from public.factory_memory_revision_bodies where revision_id=pg_temp.retention_id(61)),
  'memory expiry protects a separate unexpired revision');
select is(public.purge_expired_factory_memory_bodies(),0,'memory expiry is retry safe');

select * from finish();
rollback;
