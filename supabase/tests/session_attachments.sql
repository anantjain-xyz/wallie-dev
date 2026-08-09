begin;

create extension if not exists pgtap with schema extensions;

select plan(19);
set local "request.jwt.claim.role" = 'service_role';

select has_table('public', 'session_attachments', 'session attachment metadata table exists');
select has_column(
  'public',
  'session_attachments',
  'delete_claimed_at',
  'attachment cleanup claims have a recoverable lease timestamp'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.session_attachments'::regclass),
  'session attachments have RLS enabled'
);
select is(
  (select public from storage.buckets where id = 'session-attachments'),
  false,
  'session attachment storage is private'
);
select is(
  (select file_size_limit from storage.buckets where id = 'session-attachments'),
  4194304::bigint,
  'storage enforces the four megabyte limit'
);
select has_function(
  'public',
  'create_session_with_first_job_and_attachments',
  array['uuid', 'uuid', 'text', 'text', 'text', 'text', 'uuid[]', 'text', 'text', 'uuid', 'uuid', 'uuid[]'],
  'transactional attachment creation wrapper exists'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.create_session_with_first_job_and_attachments(uuid,uuid,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[])',
    'EXECUTE'
  ),
  'authenticated callers cannot bypass the privileged creation route'
);
select ok(
  not has_table_privilege('authenticated', 'public.session_attachments', 'SELECT'),
  'authenticated callers cannot select the service-only attachment table'
);

insert into public.session_attachments (
  id,
  workspace_id,
  uploaded_by_member_id,
  original_filename,
  content_type,
  size_bytes,
  storage_path,
  status,
  expires_at
)
values (
  'a0000000-0000-4000-8000-000000000001',
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'design.png',
  'image/png',
  1024,
  'b1b2c3d4-0001-4000-8000-000000000001/design.png',
  'ready',
  now() + interval '24 hours'
);

create temp table attachment_create_result as
select *
from public.create_session_with_first_job_and_attachments(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Image attachment proof',
  'Implement the attached design.',
  'codex',
  'gpt-5.5',
  array['a0000000-0000-4000-8000-000000000001'::uuid],
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null,
  null
);

select is((select count(*)::integer from attachment_create_result), 1, 'wrapper creates one session');
select is(
  (select status from public.session_attachments where id = 'a0000000-0000-4000-8000-000000000001'),
  'attached',
  'attachment is bound before commit'
);
select is(
  (select position::integer from public.session_attachments where id = 'a0000000-0000-4000-8000-000000000001'),
  1,
  'attachment order follows the input id array'
);
select is(
  (
    select attachment.session_id
    from public.session_attachments attachment
    where attachment.id = 'a0000000-0000-4000-8000-000000000001'
  ),
  (select session_id from attachment_create_result),
  'attachment points at the transactionally created session'
);
select ok(
  exists (
    select 1
    from public.agent_jobs job
    join attachment_create_result result on result.job_id = job.id
    where job.session_id = result.session_id
  ),
  'the first job is created in the same transaction'
);

insert into public.session_attachments (
  id,
  workspace_id,
  uploaded_by_member_id,
  original_filename,
  content_type,
  size_bytes,
  storage_path,
  status,
  expires_at
)
values (
  'a0000000-0000-4000-8000-000000000002',
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'expired.png',
  'image/png',
  1024,
  'b1b2c3d4-0001-4000-8000-000000000001/expired.png',
  'ready',
  now() - interval '1 minute'
);

select throws_ok(
  $$
    select *
    from public.create_session_with_first_job_and_attachments(
      'b1b2c3d4-0001-4000-8000-000000000001',
      'c1b2c3d4-0001-4000-8000-000000000001',
      'Expired image proof',
      'This transaction must roll back.',
      'codex',
      'gpt-5.5',
      array['a0000000-0000-4000-8000-000000000002'::uuid],
      null,
      null,
      '12b2c3d4-0001-4000-8000-000000000001',
      null,
      null
    )
  $$,
  'P0004',
  'Session attachments changed, expired, or are not available',
  'expired attachments abort session creation'
);
select is(
  (
    select count(*)::integer
    from public.sessions
    where title = 'Expired image proof'
  ),
  0,
  'failed attachment validation leaves no session or job behind'
);

insert into public.session_attachments (
  id,
  workspace_id,
  uploaded_by_member_id,
  original_filename,
  content_type,
  size_bytes,
  storage_path,
  status,
  expires_at,
  delete_claimed_at
)
values
  (
    'a0000000-0000-4000-8000-000000000003',
    'b1b2c3d4-0001-4000-8000-000000000001',
    'c1b2c3d4-0001-4000-8000-000000000001',
    'stale-deletion.png',
    'image/png',
    1024,
    'b1b2c3d4-0001-4000-8000-000000000001/stale-deletion.png',
    'deleting',
    now() - interval '1 hour',
    now() - interval '16 minutes'
  ),
  (
    'a0000000-0000-4000-8000-000000000004',
    'b1b2c3d4-0001-4000-8000-000000000001',
    'c1b2c3d4-0001-4000-8000-000000000001',
    'active-deletion.png',
    'image/png',
    1024,
    'b1b2c3d4-0001-4000-8000-000000000001/active-deletion.png',
    'deleting',
    now() - interval '1 hour',
    now()
  );

create temp table attachment_cleanup_claims as
select * from public.claim_expired_session_attachments(10);

select is(
  (select count(*)::integer from attachment_cleanup_claims),
  2,
  'cleanup claims expired ready uploads and stale deletion leases'
);
select ok(
  exists (
    select 1
    from attachment_cleanup_claims
    where id = 'a0000000-0000-4000-8000-000000000002'
  ),
  'cleanup claims a newly expired pending upload'
);
select ok(
  exists (
    select 1
    from attachment_cleanup_claims
    where id = 'a0000000-0000-4000-8000-000000000003'
      and delete_claimed_at > now() - interval '1 minute'
  ),
  'cleanup renews and reclaims an interrupted deletion lease'
);
select ok(
  not exists (
    select 1
    from attachment_cleanup_claims
    where id = 'a0000000-0000-4000-8000-000000000004'
  ),
  'cleanup does not steal an active deletion lease'
);

select * from finish();
rollback;
