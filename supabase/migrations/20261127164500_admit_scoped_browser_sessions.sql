create or replace function internal.create_session_command_once(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  expected_factory_definition_digest text, session_title text, session_prompt_md text,
  agent_model_provider text, agent_model_name text, session_attachment_ids uuid[],
  session_linear_issue_id text default null, session_linear_issue_url text default null,
  session_github_repository_id uuid default null, selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null, source_session_id uuid default null, target_factory_id uuid default null
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  accepted record;
  admitted_factory_id uuid;
  attachment_count integer := coalesce(cardinality(session_attachment_ids), 0);
  bound_attachment_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text
      || ':' || target_request_id::text, 0));
  select * into accepted from public.find_session_creation_command(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash,
    target_factory_id, source_session_id);
  if found then
    return query select accepted.session_id, accepted.session_number, accepted.workspace_slug,
      accepted.job_id, accepted.run_id;
    return;
  end if;

  if exists (
    select 1 from public.factories factory
    where (factory.workspace_id, factory.id) = (target_workspace_id, target_factory_id)
      and not factory.is_default
  ) then
    perform internal.assert_session_mutation_human_access(target_workspace_id, target_factory_id, creator_member_id);
    perform internal.assert_factory_accepts_work(target_workspace_id, target_factory_id);
    if nullif(expected_factory_definition_digest, '') is null then
      raise exception 'Publish a factory definition before starting a session here.' using errcode = 'PT422';
    end if;
    if source_session_id is not null or session_linear_issue_id is not null or session_linear_issue_url is not null then
      raise exception 'Start a new session from a prompt in this factory.' using errcode = '22023';
    end if;
    if attachment_count > 5 then
      raise exception 'A session may include at most five image attachments' using errcode = '22023';
    end if;
    perform internal.lock_factory_session_creation_attachments(target_workspace_id, creator_member_id, session_attachment_ids);
    select * into strict accepted from internal.create_attributed_session(
      target_workspace_id, creator_member_id, session_title, session_prompt_md,
      agent_model_provider, agent_model_name,
      session_github_repository_id => session_github_repository_id,
      selected_pipeline_id => selected_pipeline_id, selected_stage_ids => selected_stage_ids,
      p_actor => row(target_workspace_id, target_factory_id, creator_member_id, null, null,
        null, null, session_github_repository_id, null)::internal.session_mutation_actor,
      p_expected_definition_digest => expected_factory_definition_digest);

    if attachment_count > 0 then
      update public.session_attachments attachment
      set session_id = accepted.session_id, position = requested.ordinality, status = 'attached',
        expires_at = null, delete_claimed_at = null, attached_at = now()
      from unnest(session_attachment_ids) with ordinality requested(id, ordinality)
      where attachment.id = requested.id and attachment.workspace_id = target_workspace_id
        and attachment.uploaded_by_member_id = creator_member_id and attachment.status = 'ready' and attachment.session_id is null;
      get diagnostics bound_attachment_count = row_count;
      if bound_attachment_count <> attachment_count then
        raise exception 'Session attachments could not be bound atomically' using errcode = 'P0004';
      end if;
    end if;

    insert into internal.session_creation_requests(workspace_id, creator_member_id, request_id, request_hash,
      session_id, job_id, run_id)
    values (target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      accepted.session_id, accepted.job_id, accepted.run_id);
  else
    select * into strict accepted from public.create_confirmed_factory_session_once_with_first_job(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      expected_factory_definition_digest, session_title, session_prompt_md,
      agent_model_provider, agent_model_name, session_attachment_ids, session_linear_issue_id,
      session_linear_issue_url, session_github_repository_id, selected_pipeline_id,
      selected_stage_ids, source_session_id);
    select session.factory_id into strict admitted_factory_id from public.sessions session
    where (session.workspace_id, session.id) = (target_workspace_id, accepted.session_id);
    if target_factory_id is not null and admitted_factory_id <> target_factory_id then
      raise exception 'The active factory changed.' using errcode = 'P0003';
    end if;
    perform internal.assert_session_command_access(target_workspace_id, admitted_factory_id, creator_member_id);
  end if;
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug,
    accepted.job_id, accepted.run_id;
end;
$$;
