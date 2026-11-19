create type public.session_conversation_author_kind as enum ('user', 'agent', 'system');
create type public.session_conversation_message_kind as enum ('message', 'initial_prompt', 'artifact_feedback', 'review_ready', 'system');

alter table public.sessions add constraint sessions_conversation_scope_unique unique (id, workspace_id, factory_id);

create table public.session_conversations (
  session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  last_sequence integer not null default 0 check (last_sequence >= 0),
  unique (session_id, workspace_id, factory_id),
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade
);

create table public.session_conversation_sources (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  source_namespace text not null check (length(source_namespace) between 1 and 192 and source_namespace !~ '[[:cntrl:]]'),
  external_thread_id text not null check (length(external_thread_id) between 1 and 256 and external_thread_id !~ '[[:cntrl:]]'),
  label text check (length(label) between 1 and 120 and label !~ '[[:cntrl:]]'),
  source_url text check (
    length(source_url) <= 2048 and source_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][^[:cntrl:][:space:]]*)?$'
    and strpos(source_url, chr(92)) = 0
  ),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, provider, source_namespace, external_thread_id),
  unique (session_id, id),
  foreign key (session_id, workspace_id, factory_id)
    references public.session_conversations(session_id, workspace_id, factory_id) on delete cascade
);

create table public.session_conversation_messages (
  session_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  sequence integer not null check (sequence > 0),
  kind public.session_conversation_message_kind not null,
  author_kind public.session_conversation_author_kind not null,
  author_label text not null check (length(author_label) between 1 and 120),
  originating_member_id uuid,
  run_id uuid,
  attempt_count integer check (attempt_count > 0),
  artifact_id uuid,
  feedback_batch_id uuid,
  source_id uuid,
  external_message_id text check (length(external_message_id) between 1 and 256 and external_message_id !~ '[[:cntrl:]]'),
  external_actor_id text check (length(external_actor_id) between 1 and 256 and external_actor_id !~ '[[:cntrl:]]'),
  body_md text not null check (length(body_md) between 1 and 4000 and btrim(body_md, E' \t\r\n') <> ''),
  body_truncated boolean not null default false,
  provenance_version smallint not null default 1 check (provenance_version = 1),
  receipt_key text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (session_id, sequence),
  unique (session_id, receipt_key),
  unique (session_id, source_id, external_message_id),
  foreign key (session_id, workspace_id, factory_id)
    references public.session_conversations(session_id, workspace_id, factory_id) on delete cascade,
  foreign key (session_id, source_id)
    references public.session_conversation_sources(session_id, id) on delete cascade,
  check ((author_kind = 'agent') = (run_id is not null and attempt_count is not null)),
  check ((run_id is null) = (attempt_count is null)),
  check (author_kind <> 'user' or originating_member_id is not null),
  check ((source_id is null and external_message_id is null and external_actor_id is null)
    or (source_id is not null and external_message_id is not null and author_kind = 'user')),
  check ((kind in ('artifact_feedback', 'review_ready')) = (artifact_id is not null)),
  check ((kind = 'artifact_feedback') = (feedback_batch_id is not null))
);

alter table public.session_conversations enable row level security;
alter table public.session_conversation_sources enable row level security;
alter table public.session_conversation_messages enable row level security;
revoke all on public.session_conversations, public.session_conversation_sources, public.session_conversation_messages
  from public, anon, authenticated, service_role;
grant select on public.session_conversations, public.session_conversation_sources, public.session_conversation_messages
  to authenticated, service_role;
create policy session_conversations_read on public.session_conversations for select to authenticated
  using (internal.can_access_session(session_id));
create policy session_conversation_sources_read on public.session_conversation_sources for select to authenticated
  using (internal.can_access_session(session_id));
create policy session_conversation_messages_read on public.session_conversation_messages for select to authenticated
  using (internal.can_access_session(session_id));

create function internal.preserve_session_conversation_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.sessions where id = old.session_id) then
    return old;
  end if;
  raise exception 'Session conversation history is append-only.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_session_conversation_history() from public, anon, authenticated, service_role;
create trigger preserve_session_conversation_messages before update or delete on public.session_conversation_messages
  for each row execute function internal.preserve_session_conversation_history();
create trigger preserve_session_conversation_sources before update or delete on public.session_conversation_sources
  for each row execute function internal.preserve_session_conversation_history();

create function internal.ensure_session_conversation(p_session public.sessions)
returns void language sql set search_path = '' as $$
  insert into public.session_conversations(session_id, workspace_id, factory_id)
  values (p_session.id, p_session.workspace_id, p_session.factory_id)
  on conflict (session_id) do nothing;
$$;
revoke all on function internal.ensure_session_conversation(public.sessions) from public, anon, authenticated, service_role;

-- Callers already hold the session row, which is the shared lock for lifecycle
-- mutations. The counter update and message commit together, so later cursors
-- cannot skip a transaction that allocated a lower sequence and committed late.
create function internal.append_session_conversation_message(
  p_session public.sessions, p_message public.session_conversation_messages
) returns table(sequence integer, replayed boolean)
language plpgsql set search_path = '' as $$
declare prior public.session_conversation_messages; appended_sequence integer;
begin
  for prior in
    select message.* from public.session_conversation_messages message
    where message.session_id = p_session.id and (
      message.receipt_key = p_message.receipt_key or
      (message.source_id, message.external_message_id) = (p_message.source_id, p_message.external_message_id))
  loop
    if (prior.kind, prior.author_kind, prior.originating_member_id, prior.run_id, prior.attempt_count,
        prior.artifact_id, prior.feedback_batch_id, prior.source_id, prior.external_message_id, prior.external_actor_id,
        prior.body_md, prior.body_truncated)
      is distinct from
      (p_message.kind, p_message.author_kind, p_message.originating_member_id, p_message.run_id, p_message.attempt_count,
        p_message.artifact_id, p_message.feedback_batch_id, p_message.source_id, p_message.external_message_id,
        p_message.external_actor_id, p_message.body_md, p_message.body_truncated) then
      raise exception 'This message receipt was already used for different input.' using errcode = 'P0005';
    end if;
    appended_sequence := prior.sequence;
  end loop;
  if appended_sequence is not null then
    return query select appended_sequence, true;
    return;
  end if;
  if p_session.archived_at is not null then
    raise exception 'Session is archived.' using errcode = 'P0003';
  end if;

  perform internal.ensure_session_conversation(p_session);
  update public.session_conversations conversation set last_sequence = last_sequence + 1
  where conversation.session_id = p_session.id returning last_sequence into strict appended_sequence;
  insert into public.session_conversation_messages (
    session_id, workspace_id, factory_id, sequence, kind, author_kind, author_label, originating_member_id,
    run_id, attempt_count, artifact_id, feedback_batch_id, source_id, external_message_id, external_actor_id,
    body_md, body_truncated, receipt_key
  ) values (
    p_session.id, p_session.workspace_id, p_session.factory_id, appended_sequence, p_message.kind, p_message.author_kind,
    left(p_message.author_label, 120), p_message.originating_member_id, p_message.run_id, p_message.attempt_count,
    p_message.artifact_id, p_message.feedback_batch_id, p_message.source_id, p_message.external_message_id,
    p_message.external_actor_id, p_message.body_md, p_message.body_truncated, p_message.receipt_key
  );
  return query select appended_sequence, false;
end;
$$;
revoke all on function internal.append_session_conversation_message(public.sessions, public.session_conversation_messages)
  from public, anon, authenticated, service_role;

create function internal.lock_session_conversation(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_actor_member_id uuid
) returns public.sessions language plpgsql set search_path = '' as $$
declare session public.sessions;
begin
  select owner.* into session from public.sessions owner
  where (owner.id, owner.workspace_id, owner.factory_id) = (p_session_id, p_workspace_id, p_factory_id)
  for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;
  perform internal.assert_session_command_access(p_workspace_id, p_factory_id, p_actor_member_id);
  return session;
end;
$$;
revoke all on function internal.lock_session_conversation(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.bind_session_conversation_source_once(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_actor_member_id uuid,
  p_provider text, p_source_namespace text, p_external_thread_id text,
  p_label text default null, p_source_url text default null
) returns setof public.session_conversation_sources
language plpgsql security definer set search_path = '' as $$
declare session public.sessions; source public.session_conversation_sources;
begin
  session := internal.lock_session_conversation(p_workspace_id, p_factory_id, p_session_id, p_actor_member_id);
  if session.archived_at is null then
    perform internal.ensure_session_conversation(session);
    insert into public.session_conversation_sources (
      session_id, workspace_id, factory_id, provider, source_namespace, external_thread_id, label, source_url
    ) values (
      session.id, session.workspace_id, session.factory_id, p_provider, p_source_namespace, p_external_thread_id,
      p_label, p_source_url
    ) on conflict (workspace_id, provider, source_namespace, external_thread_id) do nothing
    returning * into source;
  end if;
  if source.id is null then
    -- Separate statement so a concurrent unique-index winner is visible.
    select existing.* into source from public.session_conversation_sources existing
    where (existing.workspace_id, existing.provider, existing.source_namespace, existing.external_thread_id) =
      (p_workspace_id, p_provider, p_source_namespace, p_external_thread_id);
    if session.archived_at is not null and source.session_id is distinct from session.id then
      raise exception 'Session is archived.' using errcode = 'P0003';
    end if;
    if source.session_id is distinct from session.id
      or source.label is distinct from p_label or source.source_url is distinct from p_source_url then
      raise exception 'This source thread association is unavailable.' using errcode = 'P0005';
    end if;
  end if;
  return next source;
end;
$$;
revoke all on function public.bind_session_conversation_source_once(uuid, uuid, uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.bind_session_conversation_source_once(uuid, uuid, uuid, uuid, text, text, text, text, text)
  to service_role;

create function public.resolve_session_conversation_source(
  p_workspace_id uuid, p_provider text, p_source_namespace text, p_external_thread_id text
) returns setof public.session_conversation_sources
language sql stable security invoker set search_path = '' as $$
  select link.* from public.session_conversation_sources link
  where (link.workspace_id, link.provider, link.source_namespace, link.external_thread_id) =
    (p_workspace_id, p_provider, p_source_namespace, p_external_thread_id);
$$;
revoke all on function public.resolve_session_conversation_source(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_session_conversation_source(uuid, text, text, text) to authenticated;

create function public.append_session_conversation_message_once(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_actor_member_id uuid, p_request_id uuid,
  p_body_md text, p_source_id uuid default null, p_external_message_id text default null, p_external_actor_id text default null
) returns table(sequence integer, replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare session public.sessions; message public.session_conversation_messages;
begin
  session := internal.lock_session_conversation(p_workspace_id, p_factory_id, p_session_id, p_actor_member_id);
  message.body_md := btrim(p_body_md, E' \t\r\n');
  if p_request_id is null or message.body_md is null or length(message.body_md) not between 1 and 4000
    or ((p_source_id is null) <> (p_external_message_id is null))
    or (p_source_id is null and p_external_actor_id is not null) then
    raise exception 'A message request id, valid source and bounded body are required.' using errcode = '22023';
  end if;
  if p_source_id is not null and not exists (
    select 1 from public.session_conversation_sources link where (link.session_id, link.id) = (session.id, p_source_id)
  ) then
    raise exception 'Session source is unavailable.' using errcode = 'PT404';
  end if;
  message.kind := 'message';
  message.author_kind := 'user';
  select internal.artifact_review_author_label(actor) into strict message.author_label
  from public.workspace_members actor where actor.id = p_actor_member_id;
  message.originating_member_id := p_actor_member_id;
  message.source_id := p_source_id;
  message.external_message_id := p_external_message_id;
  message.external_actor_id := p_external_actor_id;
  message.body_truncated := false;
  message.receipt_key := 'user:' || p_actor_member_id::text || ':' || p_request_id::text;
  return query select * from internal.append_session_conversation_message(session, message);
end;
$$;
revoke all on function public.append_session_conversation_message_once(uuid, uuid, uuid, uuid, uuid, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.append_session_conversation_message_once(uuid, uuid, uuid, uuid, uuid, text, uuid, text, text)
  to service_role;

create function internal.capture_session_conversation_prompt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  message public.session_conversation_messages;
  prompt text := btrim(new.prompt_md, E' \t\r\n');
begin
  if prompt = '' or new.archived_at is not null then return new; end if;
  message.kind := 'initial_prompt';
  select internal.artifact_review_author_label(actor) into message.author_label
  from public.workspace_members actor
  where (actor.id, actor.workspace_id) = (new.creator_member_id, new.workspace_id) and actor.kind = 'human';
  if found then
    message.author_kind := 'user';
    message.originating_member_id := new.creator_member_id;
  else
    message.author_kind := 'system';
    message.author_label := 'Wallie';
    message.originating_member_id := new.creator_member_id;
  end if;
  message.body_md := rtrim(left(prompt, 4000), E' \t\r\n');
  message.body_truncated := length(prompt) > 4000;
  message.receipt_key := 'initial_prompt';
  perform internal.append_session_conversation_message(new, message);
  return new;
end;
$$;
revoke all on function internal.capture_session_conversation_prompt() from public, anon, authenticated, service_role;
create trigger capture_session_conversation_prompt after insert on public.sessions
  for each row execute function internal.capture_session_conversation_prompt();

create function internal.capture_session_conversation_feedback()
returns trigger language plpgsql security definer set search_path = '' as $$
declare session public.sessions; message public.session_conversation_messages;
begin
  select owner.* into strict session from public.sessions owner
  where (owner.id, owner.workspace_id) = (new.session_id, new.workspace_id) for no key update;
  message.kind := 'artifact_feedback';
  message.author_kind := 'user';
  message.author_label := new.actor_label;
  message.originating_member_id := new.requested_by_member_id;
  message.artifact_id := new.artifact_id;
  message.feedback_batch_id := new.id;
  -- The immutable batch already retains the exact inline comments and quotes.
  -- Only capture the submitter's own prose here and link to the reviewed input.
  message.body_md := coalesce(nullif(btrim(new.whole_stage_feedback, E' \t\r\n'), ''), 'Submitted inline feedback.');
  message.body_truncated := false;
  message.receipt_key := 'artifact_feedback:' || new.id::text;
  perform internal.append_session_conversation_message(session, message);
  return new;
end;
$$;
revoke all on function internal.capture_session_conversation_feedback() from public, anon, authenticated, service_role;
create trigger capture_session_conversation_feedback after insert on public.artifact_feedback_batches
  for each row execute function internal.capture_session_conversation_feedback();

-- Keep the established publication and ownership checks. The wrapper only
-- appends after that exact run successfully publishes its artifact, holding the
-- same locks and honoring the same deadline through the new write.
alter function public.publish_session_job_attempt(uuid, integer, uuid, integer, text, timestamptz)
  set schema internal;
alter function internal.publish_session_job_attempt(uuid, integer, uuid, integer, text, timestamptz)
  rename to publish_session_job_attempt_without_conversation;
revoke all on function internal.publish_session_job_attempt_without_conversation(uuid, integer, uuid, integer, text, timestamptz)
  from public, anon, authenticated, service_role;

create function internal.publish_session_job_attempt_with_conversation(
  p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_expected_artifact_version integer,
  p_artifact_json text, p_deadline_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
declare session public.sessions; run public.agent_runs; message public.session_conversation_messages;
begin
  if not internal.publish_session_job_attempt_without_conversation(
    p_job_id, p_attempt_count, p_run_id, p_expected_artifact_version, p_artifact_json, p_deadline_at) then
    return false;
  end if;
  select * into strict run from public.agent_runs where id = p_run_id;
  select * into strict session from public.sessions where id = run.session_id;
  message.kind := 'review_ready';
  message.author_kind := 'agent';
  message.author_label := coalesce((select agent.name from public.factory_agents agent
    where (agent.workspace_id, agent.factory_id, agent.id) = (session.workspace_id, session.factory_id, run.agent_id)), 'Wallie');
  message.originating_member_id := run.triggered_by_member_id;
  message.run_id := run.id;
  message.attempt_count := run.attempt_count;
  message.artifact_id := session.current_artifact_id;
  message.body_md := 'An artifact is ready for review.';
  message.body_truncated := false;
  message.receipt_key := 'review_ready:' || session.current_artifact_id::text;
  perform internal.append_session_conversation_message(session, message);
  if p_deadline_at is not null and clock_timestamp() >= p_deadline_at then
    raise exception 'Worker attempt exceeded its publication deadline.' using errcode = '57014';
  end if;
  return true;
end;
$$;
revoke all on function internal.publish_session_job_attempt_with_conversation(uuid, integer, uuid, integer, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function internal.publish_session_job_attempt_with_conversation(uuid, integer, uuid, integer, text, timestamptz)
  to service_role;

create function public.publish_session_job_attempt(
  p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_expected_artifact_version integer,
  p_artifact_json text, p_deadline_at timestamptz default null
) returns boolean language sql security invoker set search_path = '' as $$
  select internal.publish_session_job_attempt_with_conversation(
    p_job_id, p_attempt_count, p_run_id, p_expected_artifact_version, p_artifact_json, p_deadline_at);
$$;
revoke all on function public.publish_session_job_attempt(uuid, integer, uuid, integer, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_session_job_attempt(uuid, integer, uuid, integer, text, timestamptz)
  to service_role;
