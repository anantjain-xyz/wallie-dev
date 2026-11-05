-- Source anchors use Unicode code points, zero based [start,end), into the
-- exact stored JSON string. No Markdown rendering, newline or Unicode normalization.
alter table public.sessions add column artifact_review_revision bigint not null default 0
  check (artifact_review_revision >= 0);

create table public.artifact_review_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  artifact_id uuid not null references public.session_artifacts(id) on delete cascade,
  -- Historical identities deliberately survive stage/member deletion.
  stage_id uuid not null,
  stage_slug text not null,
  artifact_version integer not null check (artifact_version > 0),
  anchor jsonb not null,
  kind text not null check (kind in ('discussion','blocking')),
  status text not null default 'open' check (status in ('open','resolved','superseded')),
  author_member_id uuid not null,
  author_label text not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index artifact_review_threads_page_idx on public.artifact_review_threads
  (artifact_id,workspace_id,created_at,id);
create index artifact_review_threads_session_idx on public.artifact_review_threads (session_id);

create table public.artifact_review_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid not null references public.artifact_review_threads(id) on delete cascade,
  author_member_id uuid not null,
  author_label text not null,
  body text not null check (char_length(btrim(body)) > 0 and char_length(body) <= 10000),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index artifact_review_comments_page_idx on public.artifact_review_comments
  (thread_id,workspace_id,created_at,id);

create table public.artifact_review_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid not null references public.artifact_review_threads(id) on delete cascade,
  actor_member_id uuid not null,
  actor_label text not null,
  event_type text not null check (event_type in ('created','commented','edited','resolved','reopened','superseded')),
  -- Includes comment ID and body revision, or old/new lifecycle state and reason.
  detail jsonb not null,
  review_revision bigint not null,
  created_at timestamptz not null default clock_timestamp()
);
create index artifact_review_events_page_idx on public.artifact_review_events
  (thread_id,workspace_id,created_at,id);

alter table public.artifact_review_threads enable row level security;
alter table public.artifact_review_comments enable row level security;
alter table public.artifact_review_events enable row level security;
revoke all on public.artifact_review_threads, public.artifact_review_comments, public.artifact_review_events
  from public, anon, authenticated, service_role;
grant select on public.artifact_review_threads, public.artifact_review_comments, public.artifact_review_events
  to authenticated, service_role;
create policy artifact_review_threads_read on public.artifact_review_threads for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));
create policy artifact_review_comments_read on public.artifact_review_comments for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));
create policy artifact_review_events_read on public.artifact_review_events for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));

-- Shared by every write RPC. No caller-supplied actor or service-role shortcut.
-- Session first: future approval/batch submission can use the same serialization point.
create function internal.artifact_review_actor(p_workspace_id uuid, p_session_id uuid)
returns public.workspace_members language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members;
begin
  if auth.uid() is null then raise exception 'Active human membership required.' using errcode='42501'; end if;
  perform 1 from public.sessions s where s.id=p_session_id and s.workspace_id=p_workspace_id
    and s.archived_at is null for no key update;
  if not found then raise exception 'Review session is unavailable.' using errcode='42501'; end if;
  select m.* into actor from public.workspace_members m where m.workspace_id=p_workspace_id
    and m.user_id=auth.uid() and m.kind='human' and m.is_active for share;
  if not found then raise exception 'Active human membership required.' using errcode='42501'; end if;
  return actor;
end;
$$;
revoke all on function internal.artifact_review_actor(uuid,uuid) from public,anon,authenticated,service_role;

create function internal.artifact_review_author_label(actor public.workspace_members)
returns text language sql immutable set search_path='' as $$
  select coalesce(nullif(actor.full_name,''),nullif(actor.username,''),'Workspace member')
$$;
revoke all on function internal.artifact_review_author_label(public.workspace_members) from public,anon,authenticated,service_role;

create function internal.valid_artifact_source_anchor(source text, anchor jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare start_pos integer; end_pos integer; prefix_text text; suffix_text text; quote_text text;
begin
  if source is null or jsonb_typeof(anchor) is distinct from 'object'
    or anchor->>'coordinateSystem' is distinct from 'unicode_code_points'
    or jsonb_typeof(anchor->'start') is distinct from 'number'
    or jsonb_typeof(anchor->'end') is distinct from 'number'
    or jsonb_typeof(anchor->'quote') is distinct from 'string'
    or jsonb_typeof(anchor->'prefix') is distinct from 'string'
    or jsonb_typeof(anchor->'suffix') is distinct from 'string' then return false; end if;
  if (anchor->>'start')::numeric <> trunc((anchor->>'start')::numeric)
    or (anchor->>'end')::numeric <> trunc((anchor->>'end')::numeric) then return false; end if;
  start_pos := (anchor->>'start')::integer; end_pos := (anchor->>'end')::integer;
  prefix_text := anchor->>'prefix'; suffix_text := anchor->>'suffix'; quote_text := anchor->>'quote';
  return start_pos >= 0 and end_pos > start_pos and end_pos <= char_length(source)
    and end_pos-start_pos <= 10000
    and char_length(prefix_text) between least(32,start_pos) and 128
    and char_length(suffix_text) between least(32,char_length(source)-end_pos) and 128
    and char_length(prefix_text) <= start_pos and char_length(suffix_text) <= char_length(source)-end_pos
    and substring(source from start_pos+1 for end_pos-start_pos)=quote_text
    and substring(source from start_pos-char_length(prefix_text)+1 for char_length(prefix_text))=prefix_text
    and substring(source from end_pos+1 for char_length(suffix_text))=suffix_text;
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end;
$$;
revoke all on function internal.valid_artifact_source_anchor(text,jsonb) from public,anon,authenticated,service_role;

create function public.create_artifact_review_thread(
  p_workspace_id uuid, p_session_id uuid, p_stage_id uuid, p_artifact_id uuid,
  p_artifact_version integer, p_anchor jsonb, p_kind text, p_body text
) returns public.artifact_review_threads language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; artifact public.session_artifacts; thread public.artifact_review_threads;
  comment public.artifact_review_comments; token bigint; label text;
begin
  actor := internal.artifact_review_actor(p_workspace_id,p_session_id);
  select a.* into artifact from public.session_artifacts a join public.sessions s on s.id=a.session_id
    join public.pipeline_stages ps on ps.id=a.stage_id and ps.pipeline_id=s.pipeline_id and ps.workspace_id=a.workspace_id
    where a.id=p_artifact_id and a.workspace_id=p_workspace_id and a.session_id=p_session_id
      and a.stage_id=p_stage_id and a.version=p_artifact_version for share of a;
  if not found then raise exception 'Artifact identity does not match the review.' using errcode='23514'; end if;
  if jsonb_typeof(artifact.artifact_json) <> 'string'
    or not internal.valid_artifact_source_anchor(artifact.artifact_json #>> '{}',p_anchor) then
    raise exception 'Invalid artifact source anchor.' using errcode='23514';
  end if;
  -- Persist only the bounded canonical fields, never arbitrary caller JSON.
  p_anchor := jsonb_build_object('coordinateSystem','unicode_code_points',
    'start',(p_anchor->>'start')::integer,'end',(p_anchor->>'end')::integer,
    'quote',p_anchor->>'quote','prefix',p_anchor->>'prefix','suffix',p_anchor->>'suffix');
  label := internal.artifact_review_author_label(actor);
  insert into public.artifact_review_threads(workspace_id,session_id,artifact_id,stage_id,stage_slug,
    artifact_version,anchor,kind,author_member_id,author_label)
  values(p_workspace_id,p_session_id,p_artifact_id,p_stage_id,artifact.stage_slug,p_artifact_version,
    p_anchor,p_kind,actor.id,label) returning * into thread;
  insert into public.artifact_review_comments(workspace_id,thread_id,author_member_id,author_label,body)
    values(p_workspace_id,thread.id,actor.id,label,p_body) returning * into comment;
  update public.sessions set artifact_review_revision=artifact_review_revision+1 where id=p_session_id
    returning artifact_review_revision into token;
  insert into public.artifact_review_events(workspace_id,thread_id,actor_member_id,actor_label,event_type,detail,review_revision)
    values(p_workspace_id,thread.id,actor.id,label,'created',
      jsonb_build_object('commentId',comment.id,'body',comment.body,'commentRevision',1),token);
  return thread;
end;
$$;

-- A reply or edit preserves the source anchor and author; all versions are retained
-- in append-only events, so later feedback batches can reference exact text.
create function public.write_artifact_review_comment(
  p_workspace_id uuid, p_thread_id uuid, p_body text,
  p_comment_id uuid default null, p_expected_revision integer default null
) returns public.artifact_review_comments language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; thread public.artifact_review_threads; comment public.artifact_review_comments;
  token bigint; old_body text; event_kind text;
begin
  select * into thread from public.artifact_review_threads where id=p_thread_id and workspace_id=p_workspace_id;
  actor := internal.artifact_review_actor(p_workspace_id,thread.session_id);
  if p_comment_id is null then
    insert into public.artifact_review_comments(workspace_id,thread_id,author_member_id,author_label,body)
      values(p_workspace_id,p_thread_id,actor.id,internal.artifact_review_author_label(actor),p_body) returning * into comment;
    event_kind := 'commented';
  else
    select * into comment from public.artifact_review_comments where id=p_comment_id and thread_id=p_thread_id
      and workspace_id=p_workspace_id for update;
    if not found or comment.author_member_id <> actor.id then
      raise exception 'Only the comment author may edit it.' using errcode='42501';
    end if;
    if comment.revision is distinct from p_expected_revision then
      raise exception 'Review comment revision is stale.' using errcode='40001';
    end if;
    old_body := comment.body;
    update public.artifact_review_comments set body=p_body, revision=revision+1,updated_at=clock_timestamp()
      where id=p_comment_id returning * into comment;
    event_kind := 'edited';
  end if;
  update public.artifact_review_threads set revision=revision+1,updated_at=clock_timestamp() where id=p_thread_id;
  update public.sessions set artifact_review_revision=artifact_review_revision+1 where id=thread.session_id
    returning artifact_review_revision into token;
  insert into public.artifact_review_events(workspace_id,thread_id,actor_member_id,actor_label,event_type,detail,review_revision)
    values(p_workspace_id,p_thread_id,actor.id,internal.artifact_review_author_label(actor),event_kind,
      jsonb_build_object('commentId',comment.id,'body',comment.body,'previousBody',old_body,'commentRevision',comment.revision),token);
  return comment;
end;
$$;

create function public.transition_artifact_review_thread(
  p_workspace_id uuid, p_thread_id uuid, p_expected_revision integer, p_status text, p_reason text
) returns public.artifact_review_threads language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; thread public.artifact_review_threads; can_review boolean; token bigint; old_status text;
begin
  select * into thread from public.artifact_review_threads where id=p_thread_id and workspace_id=p_workspace_id;
  actor := internal.artifact_review_actor(p_workspace_id,thread.session_id);
  select * into thread from public.artifact_review_threads where id=p_thread_id and workspace_id=p_workspace_id for update;
  if thread.revision is distinct from p_expected_revision then
    raise exception 'Review thread revision is stale.' using errcode='40001';
  end if;
  select coalesce(ps.anyone_can_approve or case when cardinality(ps.approver_member_ids)>0
    then actor.id=any(ps.approver_member_ids) else actor.role in ('owner','admin') end,false)
    into can_review from public.pipeline_stages ps join public.sessions s on s.pipeline_id=ps.pipeline_id
    where s.id=thread.session_id and ps.workspace_id=p_workspace_id and ps.id=thread.stage_id for share of ps;
  if not coalesce(can_review,false) and (thread.kind='blocking' or actor.id <> thread.author_member_id) then
    raise exception 'Authorized human reviewer required.' using errcode='42501';
  end if;
  if p_status not in ('open','resolved','superseded') or p_status is null or p_status=thread.status
    or (thread.status <> 'open' and p_status <> 'open')
    or char_length(btrim(coalesce(p_reason,'')))=0 or char_length(p_reason)>10000 then
    raise exception 'Invalid review lifecycle transition.' using errcode='23514';
  end if;
  old_status := thread.status;
  update public.artifact_review_threads set status=p_status,revision=revision+1,updated_at=clock_timestamp()
    where id=p_thread_id returning * into thread;
  update public.sessions set artifact_review_revision=artifact_review_revision+1 where id=thread.session_id
    returning artifact_review_revision into token;
  insert into public.artifact_review_events(workspace_id,thread_id,actor_member_id,actor_label,event_type,detail,review_revision)
    values(p_workspace_id,p_thread_id,actor.id,internal.artifact_review_author_label(actor),
      case when p_status='open' then 'reopened' else p_status end,
      jsonb_build_object('previousStatus',old_status,'status',p_status,'reason',p_reason),token);
  return thread;
end;
$$;

-- Keyset pages are independent: reading a thread never pulls its full comment/event history.
create function public.list_artifact_review_threads(
  p_workspace_id uuid,p_artifact_id uuid,p_limit integer default 50,
  p_after_created_at timestamptz default null,p_after_id uuid default null
) returns setof public.artifact_review_threads language sql stable security invoker set search_path='' as $$
  select t.* from public.artifact_review_threads t where t.workspace_id=p_workspace_id and t.artifact_id=p_artifact_id
    and (p_after_created_at is null or (t.created_at,t.id)>(p_after_created_at,p_after_id))
  order by t.created_at,t.id limit least(greatest(coalesce(p_limit,50),1),100)
$$;
create function public.list_artifact_review_comments(
  p_workspace_id uuid,p_thread_id uuid,p_limit integer default 50,
  p_after_created_at timestamptz default null,p_after_id uuid default null
) returns setof public.artifact_review_comments language sql stable security invoker set search_path='' as $$
  select c.* from public.artifact_review_comments c where c.workspace_id=p_workspace_id and c.thread_id=p_thread_id
    and (p_after_created_at is null or (c.created_at,c.id)>(p_after_created_at,p_after_id))
  order by c.created_at,c.id limit least(greatest(coalesce(p_limit,50),1),100)
$$;
create function public.list_artifact_review_events(
  p_workspace_id uuid,p_thread_id uuid,p_limit integer default 50,
  p_after_created_at timestamptz default null,p_after_id uuid default null
) returns setof public.artifact_review_events language sql stable security invoker set search_path='' as $$
  select e.* from public.artifact_review_events e where e.workspace_id=p_workspace_id and e.thread_id=p_thread_id
    and (p_after_created_at is null or (e.created_at,e.id)>(p_after_created_at,p_after_id))
  order by e.created_at,e.id limit least(greatest(coalesce(p_limit,50),1),100)
$$;

revoke all on function public.create_artifact_review_thread(uuid,uuid,uuid,uuid,integer,jsonb,text,text),
  public.write_artifact_review_comment(uuid,uuid,text,uuid,integer),
  public.transition_artifact_review_thread(uuid,uuid,integer,text,text),
  public.list_artifact_review_threads(uuid,uuid,integer,timestamptz,uuid),
  public.list_artifact_review_comments(uuid,uuid,integer,timestamptz,uuid),
  public.list_artifact_review_events(uuid,uuid,integer,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_artifact_review_thread(uuid,uuid,uuid,uuid,integer,jsonb,text,text),
  public.write_artifact_review_comment(uuid,uuid,text,uuid,integer),
  public.transition_artifact_review_thread(uuid,uuid,integer,text,text),
  public.list_artifact_review_threads(uuid,uuid,integer,timestamptz,uuid),
  public.list_artifact_review_comments(uuid,uuid,integer,timestamptz,uuid),
  public.list_artifact_review_events(uuid,uuid,integer,timestamptz,uuid) to authenticated;

-- Freeze legacy artifacts too, once any review anchor references them. Real
-- parent deletion can cascade, and stage deletion may null only the live FK.
create function internal.guard_reviewed_artifact_identity()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.workspaces w where w.id=old.workspace_id)
    or not exists(select 1 from public.sessions s where s.id=old.session_id) then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if exists(select 1 from public.artifact_review_threads t where t.artifact_id=old.id) then
    if tg_op='DELETE' then
      if exists(select 1 from public.sessions s where s.id=old.session_id) then
        raise exception 'Reviewed artifact identity and content are immutable.' using errcode='23514';
      end if;
    elsif new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id or new.stage_slug is distinct from old.stage_slug
      or new.version is distinct from old.version or new.artifact_json is distinct from old.artifact_json
      or new.created_at is distinct from old.created_at
      or (new.stage_id is distinct from old.stage_id and not (new.stage_id is null
        and not exists(select 1 from public.pipeline_stages ps where ps.id=old.stage_id))) then
      raise exception 'Reviewed artifact identity and content are immutable.' using errcode='23514';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function internal.guard_reviewed_artifact_identity() from public,anon,authenticated,service_role;
create trigger guard_reviewed_artifact_identity before update or delete on public.session_artifacts
  for each row execute function internal.guard_reviewed_artifact_identity();
