begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role"='service_role';

-- Entire fixture is rolled back; no shared seed sessions or memberships change.
insert into auth.users(id,email) values
 ('50000000-0000-4000-8000-000000000001','review-owner@example.test'),
 ('50000000-0000-4000-8000-000000000002','review-author@example.test'),
 ('50000000-0000-4000-8000-000000000003','review-reviewer@example.test'),
 ('50000000-0000-4000-8000-000000000004','review-inactive@example.test'),
 ('50000000-0000-4000-8000-000000000005','review-outsider@example.test'),
 ('50000000-0000-4000-8000-000000000006','review-admin@example.test');
insert into public.workspaces(id,slug,name) values
 ('50000000-0000-4000-8000-000000000010','artifact-review-fixture','Review fixture'),
 ('50000000-0000-4000-8000-000000000011','artifact-review-other','Other review workspace');
insert into public.workspace_members(id,workspace_id,user_id,kind,role,is_active,full_name) values
 ('50000000-0000-4000-8000-000000000101','50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000001','human','owner',true,'Owner'),
 ('50000000-0000-4000-8000-000000000102','50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000002','human','member',true,'Original author'),
 ('50000000-0000-4000-8000-000000000103','50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000003','human','member',true,'Reviewer'),
 ('50000000-0000-4000-8000-000000000104','50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000004','human','member',false,'Inactive'),
 ('50000000-0000-4000-8000-000000000105','50000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000005','human','owner',true,'Outsider'),
 ('50000000-0000-4000-8000-000000000106','50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000006','human','admin',true,'Admin'),
 ('50000000-0000-4000-8000-000000000107','50000000-0000-4000-8000-000000000010',null,'system','agent',true,'Agent');
insert into public.pipelines(id,workspace_id,name) values
 ('50000000-0000-4000-8000-000000000020','50000000-0000-4000-8000-000000000010','Review'),
 ('50000000-0000-4000-8000-000000000021','50000000-0000-4000-8000-000000000011','Other');
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,anyone_can_approve) values
 ('50000000-0000-4000-8000-000000000030','50000000-0000-4000-8000-000000000020','50000000-0000-4000-8000-000000000010',1,'review','Review',false),
 ('50000000-0000-4000-8000-000000000031','50000000-0000-4000-8000-000000000020','50000000-0000-4000-8000-000000000010',2,'later','Later',true),
 ('50000000-0000-4000-8000-000000000032','50000000-0000-4000-8000-000000000021','50000000-0000-4000-8000-000000000011',1,'other','Other',true);
insert into public.sessions(id,workspace_id,number,title,pipeline_id,current_stage_id,phase_status) values
 ('50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000010',1,'Review test','50000000-0000-4000-8000-000000000020','50000000-0000-4000-8000-000000000030','awaiting_review'),
 ('50000000-0000-4000-8000-000000000041','50000000-0000-4000-8000-000000000010',2,'Other session','50000000-0000-4000-8000-000000000020','50000000-0000-4000-8000-000000000031','awaiting_review'),
 ('50000000-0000-4000-8000-000000000042','50000000-0000-4000-8000-000000000011',1,'Foreign session','50000000-0000-4000-8000-000000000021','50000000-0000-4000-8000-000000000032','awaiting_review');
insert into public.session_artifacts(id,workspace_id,session_id,stage_id,stage_slug,version,artifact_json) values
 ('50000000-0000-4000-8000-000000000050','50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','review',1,to_jsonb(E'# Review 🚀\n\n```ts\nconst café = "é";\n```\nrepeat repeat é\r\n'::text)),
 ('50000000-0000-4000-8000-000000000051','50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','review',2,'{"structured":true}'),
 ('50000000-0000-4000-8000-000000000052','50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','historical-review',1,to_jsonb('Different duplicate version'::text));

create function pg_temp.review_anchor(source text,start_pos integer,end_pos integer) returns jsonb language sql as $$
 select jsonb_build_object('coordinateSystem','unicode_code_points','start',start_pos,'end',end_pos,
  'quote',substring(source from start_pos+1 for end_pos-start_pos),
  'prefix',substring(source from greatest(1,start_pos-31) for least(32,start_pos)),
  'suffix',substring(source from end_pos+1 for 32));
$$;
create function pg_temp.review_create(kind text default 'discussion') returns public.artifact_review_threads language sql as $$
 select public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
  '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030',
  '50000000-0000-4000-8000-000000000050',1,
  pg_temp.review_anchor(a.artifact_json #>> '{}',0,8),kind,'Initial comment')
 from public.session_artifacts a where a.id='50000000-0000-4000-8000-000000000050';
$$;

-- The database and browser contract count Unicode code points, not UTF-16 units,
-- grapheme clusters, rendered Markdown characters, or normalized newlines.
select ok(internal.valid_artifact_source_anchor('A😀éB',
 '{"coordinateSystem":"unicode_code_points","start":1,"end":4,"quote":"😀é","prefix":"A","suffix":"B"}'),
 'astral and combining characters use exact code-point offsets');
select ok(not internal.valid_artifact_source_anchor('A😀éB',
 '{"coordinateSystem":"unicode_code_points","start":1,"end":3,"quote":"😀é","prefix":"A","suffix":"B"}'),
 'UTF-16 or grapheme-based offsets cannot silently anchor the wrong source');
select ok(internal.valid_artifact_source_anchor(E'```ts\r\nlet x = 1;\r\n```',
 pg_temp.review_anchor(E'```ts\r\nlet x = 1;\r\n```',7,17)),
 'code fences and CRLF remain exact source text');
select ok(not internal.valid_artifact_source_anchor(E'a\r\nb',
 '{"coordinateSystem":"unicode_code_points","start":0,"end":3,"quote":"a\nb","prefix":"","suffix":""}'),
 'newline normalization invalidates an anchor');
select ok(internal.valid_artifact_source_anchor('repeat repeat',
 '{"coordinateSystem":"unicode_code_points","start":7,"end":13,"quote":"repeat","prefix":"repeat ","suffix":""}'),
 'repeated text is identified by the explicit range and context');
select ok(not internal.valid_artifact_source_anchor('repeat repeat',
 '{"coordinateSystem":"unicode_code_points","start":0,"end":6,"quote":"repeat","prefix":"repeat ","suffix":""}'),
 'quote search cannot substitute a different repeated occurrence');
select ok(not internal.valid_artifact_source_anchor(repeat('a',80),
 '{"coordinateSystem":"unicode_code_points","start":40,"end":41,"quote":"a","prefix":"","suffix":""}'),
 'long source requires enough quoted context');
select ok(not internal.valid_artifact_source_anchor('abc',pg_temp.review_anchor('abc',0,1)||'{"start":0.5}'),
 'fractional offsets fail validation');
select ok(not internal.valid_artifact_source_anchor('abc',pg_temp.review_anchor('abc',0,1)||'{"end":1e100}'),
 'out-of-range numeric offsets fail closed');
select ok(not internal.valid_artifact_source_anchor('abc',pg_temp.review_anchor('abc',0,1)||'{"coordinateSystem":"utf16"}'),
 'unknown coordinate systems fail closed');
select ok(not internal.valid_artifact_source_anchor('abc','null'), 'null anchors fail closed');
select ok(not internal.valid_artifact_source_anchor('abc',pg_temp.review_anchor('abc',0,0)), 'empty selections fail closed');

set local role authenticated;
set local "request.jwt.claim.role"='authenticated';
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000002';
create temp table review_discussion as select * from pg_temp.review_create();
select is((select author_label from review_discussion),'Original author','author identity is derived from the authenticated active human');
select is((select artifact_version from review_discussion),1,'thread captures the immutable artifact version');
select is((select count(*) from public.artifact_review_comments where thread_id=(select id from review_discussion)),1::bigint,
 'creating a thread records its initial comment atomically');
select is((select artifact_review_revision from public.sessions where id='50000000-0000-4000-8000-000000000040'),1::bigint,
 'creating a thread increments the review token once');
select throws_ok($$insert into public.artifact_review_threads(workspace_id,session_id,artifact_id,stage_id,stage_slug,artifact_version,anchor,kind,author_member_id,author_label)
 values('50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000050','50000000-0000-4000-8000-000000000030','review',1,'{}','discussion','50000000-0000-4000-8000-000000000101','Spoofed')$$,
 '42501','permission denied for table artifact_review_threads','direct writes cannot spoof author or anchor identity');
select throws_ok($$update public.artifact_review_comments set body='Bypass RPC'$$,
 '42501','permission denied for table artifact_review_comments','direct comment edits are denied');
select throws_ok($$delete from public.artifact_review_events$$,
 '42501','permission denied for table artifact_review_events','lifecycle and edit history cannot be deleted by a member');
select throws_ok($$select public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 '50000000-0000-4000-8000-000000000041','50000000-0000-4000-8000-000000000030','50000000-0000-4000-8000-000000000050',1,
 (select anchor from review_discussion),'discussion','Wrong session')$$,
 '23514','Artifact identity does not match the review.','supplied session must own the artifact');
select throws_ok($$select public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000031','50000000-0000-4000-8000-000000000050',1,
 (select anchor from review_discussion),'discussion','Wrong stage')$$,
 '23514','Artifact identity does not match the review.','supplied stage must own the artifact');
select throws_ok($$select public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','50000000-0000-4000-8000-000000000050',2,
 (select anchor from review_discussion),'discussion','Wrong version')$$,
 '23514','Artifact identity does not match the review.','supplied version must match the exact artifact');
select throws_ok($$select public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','50000000-0000-4000-8000-000000000052',1,
 (select anchor from review_discussion),'discussion','Duplicate version')$$,
 '23514','Invalid artifact source anchor.','equal stage and version cannot substitute different source text');
select throws_ok($$select public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','50000000-0000-4000-8000-000000000051',2,
 (select anchor from review_discussion),'discussion','Structured')$$,
 '23514','Invalid artifact source anchor.','structured artifact payloads cannot receive source anchors');

-- Replies and author-only edits retain immutable anchor identity and history.
create temp table review_reply as select * from public.write_artifact_review_comment_once(gen_random_uuid(),
 '50000000-0000-4000-8000-000000000010',(select id from review_discussion),'Reply');
select is((public.write_artifact_review_comment_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),'Edited reply',(select id from review_reply),1)).revision,2,'author may edit with the current comment revision');
select is((select anchor from public.artifact_review_threads where id=(select id from review_discussion)),
 (select anchor from review_discussion),'comment editing preserves the exact source anchor');
select throws_ok($$select public.write_artifact_review_comment_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),'Stale edit',(select id from review_reply),1)$$,
 '40001','Review comment revision is stale.','stale comment edits are rejected');
select is((select detail->>'previousBody' from public.artifact_review_events where thread_id=(select id from review_discussion) and event_type='edited'),
 'Reply','edit history retains the previous body');
select is((select detail->>'body' from public.artifact_review_events where thread_id=(select id from review_discussion) and event_type='commented'),
 'Reply','original reply history remains immutable after editing');
create temp table review_blocking as select * from pg_temp.review_create('blocking');
select ok(not ((public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','50000000-0000-4000-8000-000000000050',1,
 (select anchor from review_discussion)||'{"untrustedExtra":"discard"}'::jsonb,'discussion','Extra anchor data')).anchor ? 'untrustedExtra'),
 'anchor creation stores only canonical coordinate fields');
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),1,'resolved','Author wants to resolve')$$,
 '42501','Authorized human reviewer required.','blocking request author cannot resolve without reviewer authority');
select is((public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),3,'resolved','Discussion complete')).status,'resolved','discussion author may close their own discussion');

-- A separate reviewer cannot edit the first author's prose or resolve under an empty allowlist.
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000003';
select throws_ok($$select public.write_artifact_review_comment_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),'Other author edit',(select id from review_reply),2)$$,
 '42501','Only the comment author may edit it.','even a reviewer cannot edit another author comment');
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),1,'resolved','Unlisted reviewer')$$,
 '42501','Authorized human reviewer required.','empty allowlist retains owner/admin fallback');
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000001';
select is((public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),1,'resolved','Owner verified')).status,'resolved','owner may resolve under fallback policy');
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),1,'open','Stale reopen')$$,
 '40001','Review thread revision is stale.','lifecycle writes fence stale thread revisions');
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000006';
select is((public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),2,'open','Admin reopened')).status,'open','admin may reopen under fallback policy');
reset role;
update public.pipeline_stages set approver_member_ids=array['50000000-0000-4000-8000-000000000103'::uuid]
 where id='50000000-0000-4000-8000-000000000030';
set local role authenticated;
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000001';
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),3,'resolved','Owner outside explicit allowlist')$$,
 '42501','Authorized human reviewer required.','explicit reviewer allowlist applies even to the owner');
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000003';
select is((public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),3,'superseded','Replaced by updated requirement')).status,'superseded','allowlisted reviewer may explicitly supersede a blocking request');
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),4,'resolved','Skip reopen')$$,
 '23514','Invalid review lifecycle transition.','terminal states require explicit reopening before another disposition');
reset role;
update public.pipeline_stages set anyone_can_approve=true where id='50000000-0000-4000-8000-000000000030';
set local role authenticated;
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000002';
select is((public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),4,'open','New information')).status,'open','anyone-can-approve permits an active human author to reopen');
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),5,'resolved',' ')$$,
 '23514','Invalid review lifecycle transition.','resolution requires an explicit non-empty reason');

-- RLS and RPC authorization matrix: inactive, foreign, anonymous, service.
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000004';
select throws_ok($$select public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','50000000-0000-4000-8000-000000000050',1,
 (select anchor from review_discussion),'discussion','Inactive create')$$,
 '42501','Active human membership required.','inactive members cannot create threads');
select is((select count(*) from public.artifact_review_threads where workspace_id='50000000-0000-4000-8000-000000000010'),0::bigint,'inactive members cannot read threads');
select is((select count(*) from public.artifact_review_comments where workspace_id='50000000-0000-4000-8000-000000000010'),0::bigint,'inactive members cannot read comments');
select is((select count(*) from public.artifact_review_events where workspace_id='50000000-0000-4000-8000-000000000010'),0::bigint,'inactive members cannot read history');
select throws_ok($$select public.write_artifact_review_comment_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),'Inactive reply')$$,'42501','Active human membership required.','inactive members cannot reply through a security-definer RPC');
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),5,'resolved','Inactive reviewer')$$,
 '42501','Active human membership required.','anyone-can-approve does not bypass active human membership');
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000005';
select is((select count(*) from public.list_artifact_review_threads('50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000050')),0::bigint,'foreign workspace members cannot read thread pages');
select is((select count(*) from public.list_artifact_review_comments('50000000-0000-4000-8000-000000000010',(select id from review_discussion))),0::bigint,'foreign workspace members cannot read comment pages');
select is((select count(*) from public.list_artifact_review_events('50000000-0000-4000-8000-000000000010',(select id from review_discussion))),0::bigint,'foreign workspace members cannot read history pages');
select throws_ok($$select public.write_artifact_review_comment_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),'Foreign reply')$$,'42501','Active human membership required.','foreign workspace member cannot mutate a known thread ID');
select throws_ok($$select public.create_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000011',
 '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000030','50000000-0000-4000-8000-000000000050',1,
 (select anchor from review_discussion),'discussion','Forged workspace')$$,
 '42501','Review session is unavailable.','foreign workspace cannot be supplied for a known session');
set local "request.jwt.claim.sub"='';
select throws_ok($$select public.write_artifact_review_comment_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),'Missing human identity')$$,
 '42501','Active human membership required.','authenticated role without a user cannot impersonate a human');
reset role;
select ok(not has_function_privilege('anon','public.create_artifact_review_thread_once(uuid,uuid,uuid,uuid,uuid,integer,jsonb,text,text)','EXECUTE'),'anonymous users cannot create threads');
select ok(not has_function_privilege('service_role','public.transition_artifact_review_thread_once(uuid,uuid,uuid,integer,text,text)','EXECUTE'),'service role cannot automatically resolve a human request');
select ok(not has_table_privilege('service_role','public.artifact_review_threads','UPDATE'),'service role cannot bypass reviewer authorization with direct updates');
select ok(not has_table_privilege('service_role','public.artifact_review_events','INSERT'),'service role cannot fabricate lifecycle history');
select ok(not has_function_privilege('authenticated','internal.artifact_review_actor(uuid,uuid)','EXECUTE'),'internal privileged actor lookup is not exposed');
grant select on review_discussion,review_reply,review_blocking to service_role;
set local role service_role;
select throws_ok($$select public.transition_artifact_review_thread_once(gen_random_uuid(),'50000000-0000-4000-8000-000000000010',
 (select id from review_blocking),5,'resolved','Agent resolution')$$,
 '42501','permission denied for function transition_artifact_review_thread_once','agent service credentials cannot resolve blocking requests');
reset role;

-- Legacy artifacts gain immutable source protection at first review.
select throws_ok($$update public.session_artifacts set artifact_json='"Changed source"' where id='50000000-0000-4000-8000-000000000050'$$,
 '23514','Reviewed artifact identity and content are immutable.','reviewed legacy source cannot be rewritten without a checkpoint');
select throws_ok($$update public.session_artifacts set version=3 where id='50000000-0000-4000-8000-000000000050'$$,
 '23514','Reviewed artifact identity and content are immutable.','reviewed artifact version cannot change');
select throws_ok($$delete from public.session_artifacts where id='50000000-0000-4000-8000-000000000050'$$,
 '23514','Reviewed artifact identity and content are immutable.','direct artifact deletion cannot erase review history');
update public.pipeline_stages set slug='renamed-review' where id='50000000-0000-4000-8000-000000000030';
select is((select stage_slug from public.artifact_review_threads where id=(select id from review_discussion)),'review','stage renaming preserves original publication labels');
select is((select artifact_review_revision from public.sessions where id='50000000-0000-4000-8000-000000000040'),
 (select count(*) from public.artifact_review_events where workspace_id='50000000-0000-4000-8000-000000000010'),'successful feedback mutations each increment the session token once');

-- Historical identity does not rely on a live membership FK.
delete from auth.users where id='50000000-0000-4000-8000-000000000002';
set local role authenticated;
set local "request.jwt.claim.sub"='50000000-0000-4000-8000-000000000003';
select is((select author_label from public.artifact_review_threads where id=(select id from review_discussion)),'Original author','thread author remains readable after account and membership deletion');
select is((select author_label from public.artifact_review_comments where id=(select id from review_reply)),'Original author','comment author remains readable after account deletion');
select is((select actor_label from public.artifact_review_events where thread_id=(select id from review_discussion) and event_type='created'),'Original author','lifecycle authorship survives account deletion');
reset role;

-- Force equal timestamps to prove UUID tie-breaking and page bounds independently
-- for each history collection. Privileged fixture insertion is not an app path.
insert into public.artifact_review_threads(id,workspace_id,session_id,artifact_id,stage_id,stage_slug,artifact_version,anchor,kind,author_member_id,author_label,created_at)
 select ('50000000-0001-4000-8000-'||lpad(n::text,12,'0'))::uuid,'50000000-0000-4000-8000-000000000010',
 '50000000-0000-4000-8000-000000000040','50000000-0000-4000-8000-000000000050','50000000-0000-4000-8000-000000000030',
 'review',1,(select anchor from review_discussion),'discussion','50000000-0000-4000-8000-000000000103','Reviewer','2099-01-01'::timestamptz
 from generate_series(1,105) n;
insert into public.artifact_review_comments(id,workspace_id,thread_id,author_member_id,author_label,body,created_at)
 select ('50000000-0002-4000-8000-'||lpad(n::text,12,'0'))::uuid,'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),'50000000-0000-4000-8000-000000000103','Reviewer','Paged reply','2099-01-01'::timestamptz from generate_series(1,105) n;
insert into public.artifact_review_events(id,workspace_id,thread_id,actor_member_id,actor_label,event_type,detail,review_revision,created_at)
 select ('50000000-0003-4000-8000-'||lpad(n::text,12,'0'))::uuid,'50000000-0000-4000-8000-000000000010',
 (select id from review_discussion),'50000000-0000-4000-8000-000000000103','Reviewer','commented','{}',1,'2099-01-01'::timestamptz from generate_series(1,105) n;
set local role authenticated;
select is((select count(*) from public.list_artifact_review_threads('50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000050',100000)),100::bigint,'thread page requests are capped at 100');
select is((select count(*) from public.list_artifact_review_comments('50000000-0000-4000-8000-000000000010',(select id from review_discussion),100000)),100::bigint,'comment page requests are capped at 100');
select is((select count(*) from public.list_artifact_review_events('50000000-0000-4000-8000-000000000010',(select id from review_discussion),100000)),100::bigint,'event page requests are capped at 100');
select is((select count(*) from public.list_artifact_review_threads('50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000050')),50::bigint,'thread reads default to bounded pages');
select is((select min(id::text) from public.list_artifact_review_threads('50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000050',100,'2099-01-01','50000000-0001-4000-8000-000000000100')),
 '50000000-0001-4000-8000-000000000101','thread cursor resumes after the last UUID when timestamps tie');
select is((select count(*) from public.list_artifact_review_threads('50000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000050',100,'2099-01-01','50000000-0001-4000-8000-000000000100')),5::bigint,'thread keyset has no skipped or repeated equal-time entries');
select is((select count(*) from public.list_artifact_review_comments('50000000-0000-4000-8000-000000000010',(select id from review_discussion),100,'2099-01-01','50000000-0002-4000-8000-000000000100')),5::bigint,'comment pagination uses both timestamp and UUID');
select is((select count(*) from public.list_artifact_review_events('50000000-0000-4000-8000-000000000010',(select id from review_discussion),100,'2099-01-01','50000000-0003-4000-8000-000000000100')),5::bigint,'history pagination uses both timestamp and UUID');
reset role;

-- A real stage deletion may null the artifact's live FK, while review snapshots survive.
update public.sessions set current_stage_id='50000000-0000-4000-8000-000000000031'
 where id='50000000-0000-4000-8000-000000000040';
select lives_ok($$delete from public.pipeline_stages where id='50000000-0000-4000-8000-000000000030'$$,'real stage deletion preserves reviewed artifact history');
select is((select stage_id from public.session_artifacts where id='50000000-0000-4000-8000-000000000050'),null::uuid,'stage deletion only clears the live artifact FK');
select is((select stage_id from public.artifact_review_threads where id=(select id from review_discussion)),
 '50000000-0000-4000-8000-000000000030'::uuid,'thread retains the original stable stage identity');
select lives_ok($$delete from public.sessions where id='50000000-0000-4000-8000-000000000040'$$,'owning session deletion cascades immutable review history');
select is((select count(*) from public.artifact_review_threads where session_id='50000000-0000-4000-8000-000000000040'),0::bigint,'session cleanup leaves no orphan review threads');
select lives_ok($$delete from public.workspaces where id='50000000-0000-4000-8000-000000000010'$$,'owning workspace deletion cleans up review state without immutable-guard failures');
select * from finish();
rollback;
