-- A caller-generated request UUID survives lost responses and retries. Receipts
-- live outside the Data API and commit atomically with their review mutation.
create table internal.artifact_review_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_member_id uuid not null,
  request_id uuid not null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  payload jsonb not null,
  response jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, actor_member_id, request_id)
);
create index artifact_review_requests_session_idx on internal.artifact_review_requests(session_id);
alter table internal.artifact_review_requests enable row level security;
revoke all on internal.artifact_review_requests from public,anon,authenticated,service_role;

-- The existing actor helper locks session -> active human member first. Claiming
-- the receipt next serializes a UUID even if two requests target different sessions.
create function internal.claim_artifact_review_request(
  p_workspace_id uuid,p_session_id uuid,p_request_id uuid,p_payload jsonb
) returns internal.artifact_review_requests language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; receipt internal.artifact_review_requests;
begin
  actor := internal.artifact_review_actor(p_workspace_id,p_session_id);
  if p_request_id is null then raise exception 'Review request id is required.' using errcode='22023'; end if;
  insert into internal.artifact_review_requests(workspace_id,actor_member_id,request_id,session_id,payload)
    values(p_workspace_id,actor.id,p_request_id,p_session_id,p_payload)
    on conflict (workspace_id,actor_member_id,request_id) do nothing;
  select * into receipt from internal.artifact_review_requests
    where workspace_id=p_workspace_id and actor_member_id=actor.id and request_id=p_request_id for update;
  if receipt.payload is distinct from p_payload then
    raise exception 'Review request id was already used with different content.' using errcode='23505';
  end if;
  return receipt;
end;
$$;
revoke all on function internal.claim_artifact_review_request(uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;

create function public.create_artifact_review_thread_once(
  p_request_id uuid,p_workspace_id uuid,p_session_id uuid,p_stage_id uuid,p_artifact_id uuid,
  p_artifact_version integer,p_anchor jsonb,p_kind text,p_body text
) returns public.artifact_review_threads language plpgsql security definer set search_path='' as $$
declare receipt internal.artifact_review_requests; result public.artifact_review_threads;
begin
  -- Match the canonical anchor projection: caller JSON cannot add unbounded receipt fields.
  p_anchor := jsonb_build_object('coordinateSystem',p_anchor->'coordinateSystem',
    'start',p_anchor->'start','end',p_anchor->'end','quote',p_anchor->'quote',
    'prefix',p_anchor->'prefix','suffix',p_anchor->'suffix');
  receipt := internal.claim_artifact_review_request(p_workspace_id,p_session_id,p_request_id,
    jsonb_build_object('operation','create','sessionId',p_session_id,'stageId',p_stage_id,
      'artifactId',p_artifact_id,'artifactVersion',p_artifact_version,'anchor',p_anchor,'kind',p_kind,'body',p_body));
  if receipt.response is not null then
    return jsonb_populate_record(null::public.artifact_review_threads,receipt.response);
  end if;
  result := public.create_artifact_review_thread(p_workspace_id,p_session_id,p_stage_id,p_artifact_id,
    p_artifact_version,p_anchor,p_kind,p_body);
  update internal.artifact_review_requests set response=to_jsonb(result)
    where workspace_id=receipt.workspace_id and actor_member_id=receipt.actor_member_id and request_id=receipt.request_id;
  return result;
end;
$$;

create function public.write_artifact_review_comment_once(
  p_request_id uuid,p_workspace_id uuid,p_thread_id uuid,p_body text,
  p_comment_id uuid default null,p_expected_revision integer default null
) returns public.artifact_review_comments language plpgsql security definer set search_path='' as $$
declare target_session_id uuid; receipt internal.artifact_review_requests; result public.artifact_review_comments;
begin
  select t.session_id into target_session_id from public.artifact_review_threads t
    where t.id=p_thread_id and t.workspace_id=p_workspace_id;
  receipt := internal.claim_artifact_review_request(p_workspace_id,target_session_id,p_request_id,
    jsonb_build_object('operation','comment','threadId',p_thread_id,'body',p_body,
      'commentId',p_comment_id,'expectedRevision',p_expected_revision));
  if receipt.response is not null then
    return jsonb_populate_record(null::public.artifact_review_comments,receipt.response);
  end if;
  result := public.write_artifact_review_comment(p_workspace_id,p_thread_id,p_body,p_comment_id,p_expected_revision);
  update internal.artifact_review_requests set response=to_jsonb(result)
    where workspace_id=receipt.workspace_id and actor_member_id=receipt.actor_member_id and request_id=receipt.request_id;
  return result;
end;
$$;

create function public.transition_artifact_review_thread_once(
  p_request_id uuid,p_workspace_id uuid,p_thread_id uuid,p_expected_revision integer,p_status text,p_reason text
) returns public.artifact_review_threads language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; target public.artifact_review_threads;
  receipt internal.artifact_review_requests; result public.artifact_review_threads; can_review boolean;
begin
  select * into target from public.artifact_review_threads where id=p_thread_id and workspace_id=p_workspace_id;
  receipt := internal.claim_artifact_review_request(p_workspace_id,target.session_id,p_request_id,
    jsonb_build_object('operation','transition','threadId',p_thread_id,'expectedRevision',p_expected_revision,
      'status',p_status,'reason',p_reason));
  if receipt.response is not null then
    -- Recovery never revives an authorization decision after access was revoked.
    -- CAS is deliberately not repeated: the receipt is the original accepted result.
    actor := internal.artifact_review_actor(p_workspace_id,target.session_id);
    select coalesce(ps.anyone_can_approve or case when cardinality(ps.approver_member_ids)>0
      then actor.id=any(ps.approver_member_ids) else actor.role in ('owner','admin') end,false)
      into can_review from public.pipeline_stages ps join public.sessions s on s.pipeline_id=ps.pipeline_id
      where s.id=target.session_id and ps.workspace_id=p_workspace_id and ps.id=target.stage_id for share of ps;
    if not coalesce(can_review,false) and (target.kind='blocking' or actor.id<>target.author_member_id) then
      raise exception 'Authorized human reviewer required.' using errcode='42501';
    end if;
    return jsonb_populate_record(null::public.artifact_review_threads,receipt.response);
  end if;
  result := public.transition_artifact_review_thread(p_workspace_id,p_thread_id,p_expected_revision,p_status,p_reason);
  update internal.artifact_review_requests set response=to_jsonb(result)
    where workspace_id=receipt.workspace_id and actor_member_id=receipt.actor_member_id and request_id=receipt.request_id;
  return result;
end;
$$;

-- Keep the old implementations as internal building blocks only. All user writes
-- now require a retry key; service-role identity alone still cannot write reviews.
revoke all on function public.create_artifact_review_thread(uuid,uuid,uuid,uuid,integer,jsonb,text,text),
  public.write_artifact_review_comment(uuid,uuid,text,uuid,integer),
  public.transition_artifact_review_thread(uuid,uuid,integer,text,text) from public,anon,authenticated,service_role;
revoke all on function public.create_artifact_review_thread_once(uuid,uuid,uuid,uuid,uuid,integer,jsonb,text,text),
  public.write_artifact_review_comment_once(uuid,uuid,uuid,text,uuid,integer),
  public.transition_artifact_review_thread_once(uuid,uuid,uuid,integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.create_artifact_review_thread_once(uuid,uuid,uuid,uuid,uuid,integer,jsonb,text,text),
  public.write_artifact_review_comment_once(uuid,uuid,uuid,text,uuid,integer),
  public.transition_artifact_review_thread_once(uuid,uuid,uuid,integer,text,text) to authenticated;

-- Thread rows change on creation, reply, edit and lifecycle mutation. One filtered
-- subscription per visible session can invalidate bounded pages for all reviewers.
alter table public.artifact_review_threads replica identity full;
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='artifact_review_threads') then
    alter publication supabase_realtime add table public.artifact_review_threads;
  end if;
end; $$;
