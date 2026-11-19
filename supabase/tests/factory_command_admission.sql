begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

create function pg_temp.command_id(slot integer) returns uuid language sql immutable as $$
  select ('56900000-0000-4000-8000-' || lpad(slot::text,12,'0'))::uuid
$$;
create function pg_temp.command_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id=pg_temp.command_id(4) and is_default
$$;
insert into auth.users(id,email) values (pg_temp.command_id(1),'command-owner@example.test'),(pg_temp.command_id(2),'command-member@example.test');
insert into auth.sessions(id,user_id,created_at,updated_at) values (pg_temp.command_id(8),pg_temp.command_id(2),now(),now());
insert into public.workspaces(id,slug,name) values (pg_temp.command_id(4),'command-admission-fixture','Command admission');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.command_id(11),pg_temp.command_id(4),pg_temp.command_id(1),'human','owner'),
  (pg_temp.command_id(12),pg_temp.command_id(4),pg_temp.command_id(2),'human','member');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values(pg_temp.command_id(21),pg_temp.command_id(4),56900001,'https://github.test/installations/56900001',56900,'Organization','command-fixture','{"contents":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
values(pg_temp.command_id(22),pg_temp.command_id(4),pg_temp.command_factory(),pg_temp.command_id(21),569001,
  'commands','fixture/commands',true,'https://github.test/fixture/commands','main');
select public.save_execution_policy(pg_temp.command_id(4),pg_temp.command_id(1),0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
select public.create_service_principal(pg_temp.command_id(4),pg_temp.command_factory(),pg_temp.command_id(1),'Command client','command-client');
select public.create_service_principal(pg_temp.command_id(4),pg_temp.command_factory(),pg_temp.command_id(1),'Other client','other-client');
create temp table command_grants as select principal.slug,approved.* from public.service_principals principal
join public.execution_policies policy on policy.workspace_id=principal.workspace_id
cross join lateral public.approve_factory_execution_grant(pg_temp.command_id(4),pg_temp.command_factory(),pg_temp.command_id(1),
  principal.id,pg_temp.command_id(22),'{}','{}',policy.current_revision_id,pg_temp.command_id(11),clock_timestamp()+interval '1 hour',0,null,
  '{sessions:read,sessions:cancel}'::public.factory_command_scope[]) approved
where principal.workspace_id=pg_temp.command_id(4);
select public.issue_factory_machine_token(workspace_id,factory_id,pg_temp.command_id(1),id,version,
  pg_temp.command_id(case when slug='command-client' then 31 else 33 end),repeat('a',64),'Fixture token','{sessions:read}')
from command_grants;
create temp table command_client as select registration.* from command_grants approved
cross join lateral public.register_factory_oauth_client(approved.workspace_id,pg_temp.command_id(1),'Fixture OAuth',
  array['http://127.0.0.1:8123/callback'],'{sessions:read,sessions:cancel}',jsonb_build_array(jsonb_build_object(
    'factory_id',approved.factory_id,'execution_grant_id',approved.id,'execution_grant_version',approved.version))) registration
where approved.slug='command-client';
create temp table command_consent as select consent.* from command_client client
cross join lateral public.begin_factory_oauth_authorization(client.id,pg_temp.command_id(2),pg_temp.command_id(8),
  'http://127.0.0.1:8123/callback',repeat('a',42)||'A','{sessions:read,sessions:cancel}') consent;
select public.decide_factory_oauth_authorization(authorization_id,pg_temp.command_id(2),pg_temp.command_id(8),true,
  array[pg_temp.command_factory()],pg_temp.command_id(36),repeat('c',64)) from command_consent;
select is((select issued.status from command_client client cross join lateral public.exchange_factory_oauth_code(
  client.id,'http://127.0.0.1:8123/callback',pg_temp.command_id(36),repeat('c',64),repeat('a',42)||'A',
  pg_temp.command_id(32),repeat('a',64),pg_temp.command_id(37),repeat('b',64)) issued),
  'issued','the exact same principal obtains independent machine-token and OAuth credentials');

create function pg_temp.command_config(workspace_rate integer,principal_rate integer,workspace_concurrent integer default 12,
  principal_concurrent integer default 4,lease_length integer default 60) returns void language sql as $$
  select public.configure_factory_command_quotas(pg_temp.command_id(4),pg_temp.command_id(1),workspace_rate,
    workspace_concurrent,principal_rate,principal_concurrent,600,lease_length);
$$;
create function pg_temp.command_admit(p_request integer,p_credential integer default 31,
  p_scope public.factory_command_scope default 'sessions:read',p_hash text default repeat('b',64),
  p_digest text default repeat('a',64),p_surface public.factory_command_surface default 'api')
returns table(status public.factory_command_admission_status,retry_after_seconds integer,admission_id uuid,lease_id uuid,
  lease_expires_at timestamptz,workspace_id uuid,factory_id uuid,service_principal_id uuid,
  execution_grant_id uuid,execution_grant_version bigint,consenting_member_id uuid,scope public.factory_command_scope)
language sql as $$
  select * from public.admit_factory_command(pg_temp.command_id(4),pg_temp.command_factory(),
    case when p_credential=32 then 'oauth_access_token'::public.factory_command_credential_kind else 'machine_token' end,
    pg_temp.command_id(p_credential),p_digest,p_scope,pg_temp.command_id(p_request),p_hash,p_surface);
$$;
select throws_ok('select pg_temp.command_config(0,10)', '22023', 'Invalid command quota limits.', 'quota settings validate bounds');
select throws_ok($q$select public.configure_factory_command_quotas(pg_temp.command_id(4),pg_temp.command_id(2),10,4,5,2)$q$,
  '42501','Workspace manager required.','ordinary members cannot change quota limits');
select ok(not has_function_privilege('authenticated',
  'public.admit_factory_command(uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope,uuid,text,public.factory_command_surface)','execute')
  and not has_table_privilege('service_role','internal.factory_command_admissions','select'),
  'browser authorization stays outside the machine RPC and its private ledger');
select is((select status::text from pg_temp.command_admit(101,p_digest=>repeat('c',64))),'unauthorized','a guessed credential yields a stable denial');
select is((select status::text from pg_temp.command_admit(101,p_scope=>'sessions:cancel')),'forbidden','a narrower machine token denies scope before admission');
select is((select status::text from pg_temp.command_admit(101,32,'sessions:create')),'forbidden','OAuth uses the same scope-denial contract');
select is((select count(*) from internal.factory_command_admissions where workspace_id=pg_temp.command_id(4)),0::bigint,
  'denials return no identity, reserve no permit and consume no quota');
select pg_temp.command_config(10,1);
create temp table accepted_machine as select * from pg_temp.command_admit(101);
select ok((select status='admitted' and lease_id is not null and consenting_member_id is null
  and service_principal_id=(select service_principal_id from command_grants where slug='command-client') from accepted_machine),
  'admission returns exact principal/grant attribution for the token without forging a human actor');
select is((select last_used_at from public.factory_machine_tokens where id=pg_temp.command_id(31)),null::timestamptz,
  'provisional admission does not mark a token successfully used');
select ok((select status='already_admitted' and lease_id is null and admission_id is null from pg_temp.command_admit(101)),
  'an exact retry does not receive another usable permit');
select ok((select status='request_conflict' and lease_id is null from pg_temp.command_admit(101,p_surface=>'mcp')),
  'changing the command surface conflicts for an accepted request key');
select throws_ok($q$select internal.record_factory_command_use(admission_id,lease_id) from accepted_machine$q$,
  'PT409','Command use must be recorded in its verified transaction.','a provisional receipt cannot be reported as a successful command');
select throws_ok($q$select internal.require_factory_command(workspace_id,factory_id,'machine_token',pg_temp.command_id(31),repeat('a',64),
  'sessions:read',pg_temp.command_id(101),repeat('c',64),'api',admission_id,lease_id) from accepted_machine$q$,
  'PT409','Command admission is unavailable.','the protected transaction rejects an altered request hash');
savepoint failed_protected_work;
select internal.require_factory_command(workspace_id,factory_id,'machine_token',pg_temp.command_id(31),repeat('a',64),
  'sessions:read',pg_temp.command_id(101),repeat('b',64),'api',admission_id,lease_id) from accepted_machine;
select throws_ok($q$select internal.require_factory_command(workspace_id,factory_id,'machine_token',pg_temp.command_id(31),
  repeat('a',64),'sessions:read',pg_temp.command_id(101),repeat('b',64),'api',admission_id,lease_id) from accepted_machine$q$,
  'PT409','Command admission is unavailable.','the same protected permit cannot verify twice even before recording successful use');
select internal.record_factory_command_use(admission_id,lease_id) from accepted_machine;
rollback to savepoint failed_protected_work;
select ok(not exists(select 1 from internal.factory_command_uses where admission_id=(select admission_id from accepted_machine))
  and (select last_used_at is null from public.factory_machine_tokens where id=pg_temp.command_id(31)),
  'rolling back protected work clears its use receipt and last-used marker');
select internal.require_factory_command(workspace_id,factory_id,'machine_token',pg_temp.command_id(31),repeat('a',64),
  'sessions:read',pg_temp.command_id(101),repeat('b',64),'api',admission_id,lease_id) from accepted_machine;
select internal.record_factory_command_use(admission_id,lease_id) from accepted_machine;
select ok((select last_used_at is not null and last_used_scope='sessions:read' from public.factory_machine_tokens where id=pg_temp.command_id(31)),
  'a verified command records actual use in the same transaction');
select ok(not public.release_factory_command_admission(admission_id,gen_random_uuid()),'a wrong permit cannot release admitted work') from accepted_machine;
select ok(public.release_factory_command_admission(admission_id,lease_id),'exact release frees only its own concurrency slot') from accepted_machine;
select ok(not public.release_factory_command_admission(admission_id,lease_id),'an already released permit has no further effect') from accepted_machine;
select ok((select status='rate_limited' and retry_after_seconds between 599 and 600 and lease_id is null from pg_temp.command_admit(102,32,p_surface=>'mcp')),
  'an OAuth request sees the same principal rate limit and cannot refund a released machine admission');
create temp table other_admission as select * from pg_temp.command_admit(103,33);
select is((select status::text from other_admission),'admitted','another principal is below its own limit while workspace capacity remains');
select public.release_factory_command_admission(admission_id,lease_id) from other_admission;
select pg_temp.command_config(2,10);
select ok((select status='rate_limited' and retry_after_seconds between 599 and 600 from pg_temp.command_admit(104,33)),
  'workspace rate retry timing binds the aggregate independently of each principal');
select pg_temp.command_config(100,100,12,1);
commit;
begin;

select extensions.dblink_connect('command_first',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('command_second',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('command_second','set application_name = ''factory_command_contender''; set statement_timeout = ''15s''');
create function pg_temp.wait_command_lock() returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists(select 1 from pg_stat_activity where application_name='factory_command_contender' and wait_event_type='Lock') then return true; end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
create function pg_temp.command_query(p_request integer,p_credential integer) returns text language sql as $$
  select format($q$select status::text,retry_after_seconds,admission_id,lease_id,lease_expires_at
    from public.admit_factory_command(%L,%L,%L,%L,repeat('a',64),'sessions:read',%L,repeat('b',64),%L)$q$,
    pg_temp.command_id(4),pg_temp.command_factory(),case when p_credential=32 then 'oauth_access_token' else 'machine_token' end,
    pg_temp.command_id(p_credential),pg_temp.command_id(p_request),case when p_credential=32 then 'mcp' else 'api' end);
$$;
select extensions.dblink_exec('command_first','begin');
create temp table race_admission as select * from extensions.dblink('command_first',pg_temp.command_query(110,31))
  result(status text,retry_after_seconds integer,admission_id uuid,lease_id uuid,lease_expires_at timestamptz);
select is((select status from race_admission),'admitted','the first worker owns the principal’s only slot before its transaction commits');
select extensions.dblink_send_query('command_second',pg_temp.command_query(111,32));
select ok(pg_temp.wait_command_lock(),'a separate OAuth/MCP worker waits on the same durable quota mutex');
select extensions.dblink_exec('command_first','commit');
select ok((select status='concurrency_limited' and retry_after_seconds between 1 and 60 and lease_id is null
  from extensions.dblink_get_result('command_second') result(status text,retry_after_seconds integer,admission_id uuid,lease_id uuid,lease_expires_at timestamptz)),
  'overlapping token and OAuth workers cannot overbook the same principal');
select count(*) from extensions.dblink_get_result('command_second')
  result(status text,retry_after_seconds integer,admission_id uuid,lease_id uuid,lease_expires_at timestamptz);
select ok(public.release_factory_command_admission(admission_id,lease_id),'the winning worker releases its exact permit') from race_admission;

-- A separate connection locks a valid permit in the real protected command
-- transaction and holds that exact lease across its nominal deadline.
select pg_temp.command_config(100,100,12,1,2);
commit;
begin;
create temp table expiring_admission as select * from extensions.dblink('command_first',pg_temp.command_query(120,31))
  result(status text,retry_after_seconds integer,admission_id uuid,lease_id uuid,lease_expires_at timestamptz);
select extensions.dblink_exec('command_first','begin');
select is((select result.id from expiring_admission admission cross join lateral extensions.dblink('command_first',format($q$
  select id from internal.require_factory_command(%L,%L,'machine_token',%L,repeat('a',64),'sessions:read',
    %L,repeat('b',64),'api',%L,%L)$q$,pg_temp.command_id(4),pg_temp.command_factory(),pg_temp.command_id(31),
    pg_temp.command_id(120),admission.admission_id,admission.lease_id)) result(id uuid)),
  (select admission_id from expiring_admission),'the protected transaction holds the exact live permit');
select pg_sleep(greatest(0,extract(epoch from lease_expires_at-clock_timestamp()))+0.03) from expiring_admission;
select ok((select status='concurrency_limited' and retry_after_seconds=1 and lease_id is null from pg_temp.command_admit(121,32,p_surface=>'mcp')),
  'an expired permit locked by a separate actual command still consumes the slot');
select results_eq('select * from public.prune_factory_command_admissions()', 'values (0, 0)',
  'maintenance skips an expired permit held by the verified command transaction');
select extensions.dblink_exec('command_first',format($q$do $$begin perform internal.record_factory_command_use(%L,%L);end$$$q$,
  admission_id,lease_id)) from expiring_admission;
select extensions.dblink_exec('command_first','commit');
create temp table recovered_admission as select * from pg_temp.command_admit(121,32,p_surface=>'mcp');
select ok((select status='admitted' and consenting_member_id=pg_temp.command_id(12) and lease_id is not null from recovered_admission),
  'retry after the protected operation releases its lock reaps the expired permit and preserves OAuth actor provenance');
select ok(exists(select 1 from internal.factory_command_admissions receipt join internal.factory_command_uses used on used.admission_id=receipt.id
    where receipt.request_id=pg_temp.command_id(120))
  and not exists(select 1 from internal.factory_command_leases lease where lease.admission_id=(select admission_id from expiring_admission)),
  'expiry reclaims concurrency without refunding the original request or its successful use');
select public.revoke_factory_oauth_grant(pg_temp.command_id(4),pg_temp.command_id(2),
  (select id from public.factory_oauth_grants where client_id=(select id from command_client)));
select throws_ok($q$select internal.require_factory_command(workspace_id,factory_id,'oauth_access_token',pg_temp.command_id(32),
  repeat('a',64),'sessions:read',pg_temp.command_id(121),repeat('b',64),'mcp',admission_id,lease_id) from recovered_admission$q$,
  '42501','OAuth token is unavailable.','a protected command rechecks authority after provisional admission');
select public.release_factory_command_admission(admission_id,lease_id) from recovered_admission;
select pg_temp.command_config(100,100,12,1);
commit;
begin;

create temp table revocation_admission as select * from extensions.dblink('command_first',pg_temp.command_query(130,31))
  result(status text,retry_after_seconds integer,admission_id uuid,lease_id uuid,lease_expires_at timestamptz);
select extensions.dblink_exec('command_first','begin');
select is((select result.id from revocation_admission admission cross join lateral extensions.dblink('command_first',format($q$
  select id from internal.require_factory_command(%L,%L,'machine_token',%L,repeat('a',64),'sessions:read',
    %L,repeat('b',64),'api',%L,%L)$q$,pg_temp.command_id(4),pg_temp.command_factory(),pg_temp.command_id(31),
    pg_temp.command_id(130),admission.admission_id,admission.lease_id)) result(id uuid)),
  (select admission_id from revocation_admission),'the protected transaction holds the live credential fence');
select extensions.dblink_send_query('command_second',format($q$
  select revoked_at from public.revoke_factory_machine_token(%L,%L,%L,%L,%L)
$q$,pg_temp.command_id(4),pg_temp.command_factory(),pg_temp.command_id(1),
  (select id from command_grants where slug='command-client'),pg_temp.command_id(31)));
select ok(pg_temp.wait_command_lock(),'concurrent revocation waits for protected work with that credential');
select extensions.dblink_exec('command_first',format($q$do $$begin perform internal.record_factory_command_use(%L,%L);end$$$q$,
  admission_id,lease_id)) from revocation_admission;
select extensions.dblink_exec('command_first','commit');
select ok((select revoked_at is not null from extensions.dblink_get_result('command_second') result(revoked_at timestamptz)),
  'revocation commits once the guarded transaction ends');
select count(*) from extensions.dblink_get_result('command_second') result(revoked_at timestamptz);
select is((select status::text from pg_temp.command_admit(131)),'unauthorized','no fresh permit can use the revoked credential');
select ok(exists(select 1 from internal.factory_command_uses where admission_id=(select admission_id from revocation_admission)),
  'the operation that ran before revocation retains its committed use receipt');
select public.release_factory_command_admission(admission_id,lease_id) from revocation_admission;

select ok(not has_function_privilege('anon','public.prune_factory_command_admissions(integer)','execute')
  and not has_function_privilege('authenticated','public.prune_factory_command_admissions(integer)','execute')
  and has_function_privilege('service_role','public.prune_factory_command_admissions(integer)','execute')
  and not has_table_privilege('service_role','internal.factory_command_admissions','delete')
  and not has_table_privilege('service_role','internal.factory_command_uses','delete'),
  'only the maintenance RPC allows service cleanup of private command history');
select throws_ok($q$delete from internal.factory_command_admissions where request_id=pg_temp.command_id(101)$q$,
  '23514','Command admissions are immutable.','recent command history cannot be deleted directly');

-- Seed historical receipts directly to exercise retention without waiting a
-- week or altering an existing receipt. The live lease models a held command
-- and the optional use entries model commands whose result already committed.
insert into internal.factory_command_admissions(id,workspace_id,factory_id,service_principal_id,
  execution_grant_id,execution_grant_version,credential_kind,credential_id,scope,surface,request_id,request_hash,admitted_at)
select pg_temp.command_id(fixture.slot),receipt.workspace_id,receipt.factory_id,receipt.service_principal_id,
  receipt.execution_grant_id,receipt.execution_grant_version,receipt.credential_kind,receipt.credential_id,receipt.scope,
  receipt.surface,pg_temp.command_id(fixture.slot),receipt.request_hash,clock_timestamp()-fixture.age
from internal.factory_command_admissions receipt
cross join (values (201,interval '9 days'),(202,interval '10 days'),(203,interval '8 days'),
  (204,interval '8 days'),(205,interval '30 seconds')) fixture(slot,age)
where receipt.workspace_id=pg_temp.command_id(4) and receipt.request_id=pg_temp.command_id(101);
insert into internal.factory_command_leases(admission_id,workspace_id,service_principal_id,expires_at)
select receipt.id,receipt.workspace_id,receipt.service_principal_id,clock_timestamp()+fixture.remaining
from (values (202,interval '-30 seconds'),(203,interval '-20 seconds'),(204,interval '1 hour'),(205,interval '-10 seconds')) fixture(slot,remaining)
join internal.factory_command_admissions receipt on receipt.id=pg_temp.command_id(fixture.slot);
insert into internal.factory_command_uses(admission_id,used_at)
select receipt.id,receipt.admitted_at from internal.factory_command_admissions receipt
where receipt.id in (pg_temp.command_id(201),pg_temp.command_id(202),pg_temp.command_id(205));
commit;
begin;
select extensions.dblink_exec('command_first','begin');
select id from extensions.dblink('command_first',format(
  'select admission_id from internal.factory_command_leases where admission_id=%L for update',pg_temp.command_id(202))) held(id uuid);
set local lock_timeout='2s';
select results_eq('select * from public.prune_factory_command_admissions(1)', 'values (1, 1)',
  'maintenance bounds both expiry and history deletions independently');
select ok(not exists(select 1 from internal.factory_command_leases where admission_id=pg_temp.command_id(203))
  and not exists(select 1 from internal.factory_command_admissions where id=pg_temp.command_id(201))
  and not exists(select 1 from internal.factory_command_uses where admission_id=pg_temp.command_id(201))
  and exists(select 1 from internal.factory_command_admissions where id=pg_temp.command_id(203))
  and exists(select 1 from internal.factory_command_leases where admission_id=pg_temp.command_id(205)),
  'cleanup removes oldest eligible rows first and cascades only their successful use');
select results_eq('select * from public.prune_factory_command_admissions(1)', 'values (1, 1)',
  'a later batch continues cleanup while preserving the held permit');
select results_eq('select * from public.prune_factory_command_admissions()', 'values (0, 0)',
  'an old admission with a locked expiry or a live lease survives every batch');
select extensions.dblink_exec('command_first','commit');
select results_eq('select * from public.prune_factory_command_admissions()', 'values (1, 1)',
  'an old expired admission and permit become pruneable after unlock');
select ok(not exists(select 1 from internal.factory_command_uses where admission_id=pg_temp.command_id(202))
  and exists(select 1 from internal.factory_command_uses where admission_id=pg_temp.command_id(205))
  and exists(select 1 from internal.factory_command_leases where admission_id=pg_temp.command_id(204)),
  'recent quota and use history and old live work remain intact');
select extensions.dblink_disconnect('command_second');
select extensions.dblink_disconnect('command_first');
delete from public.workspaces where id=pg_temp.command_id(4);
select ok(not exists(select 1 from internal.factory_command_admissions where workspace_id=pg_temp.command_id(4))
  and not exists(select 1 from internal.factory_command_leases where admission_id=pg_temp.command_id(204))
  and not exists(select 1 from internal.factory_command_uses where admission_id=pg_temp.command_id(205)),
  'workspace deletion still cascades recent receipts, live permits and successful uses');
delete from auth.users where id in (pg_temp.command_id(1),pg_temp.command_id(2));
select * from finish();
commit;
