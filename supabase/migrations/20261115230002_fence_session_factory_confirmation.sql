-- Bind the create dialog's exact revision to the existing atomic admission.
-- Keep lock order request -> attachments -> workspace -> admission resources.
create function public.create_confirmed_factory_session_once_with_first_job(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  expected_factory_definition_digest text, session_title text, session_prompt_md text,
  agent_model_provider text, agent_model_name text, session_attachment_ids uuid[],
  session_linear_issue_id text default null, session_linear_issue_url text default null,
  session_github_repository_id uuid default null, selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null, source_session_id uuid default null
)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare accepted record; active_digest text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text
      || ':' || target_request_id::text, 0));
  select * into accepted from public.find_session_creation_request(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash);
  if found then
    if source_session_id is distinct from (
      select lineage.source_session_id from public.session_restart_lineages lineage
      where (lineage.workspace_id, lineage.session_id) = (target_workspace_id, accepted.session_id)
    ) then
      raise exception 'This creation request was already used for different session input' using errcode = 'P0005';
    end if;
    return query select accepted.session_id::uuid, accepted.session_number::integer,
      accepted.workspace_slug::text, accepted.job_id::uuid, accepted.run_id::uuid;
    return;
  end if;

  perform internal.lock_factory_session_creation_attachments(target_workspace_id, creator_member_id, session_attachment_ids);
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  select revision.canonical_digest into active_digest
  from public.factories factory
  join public.factory_definition_activations activation
    on (activation.workspace_id, activation.factory_id) = (factory.workspace_id, factory.id)
  join public.factory_definition_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id) =
      (activation.workspace_id, activation.factory_id, activation.revision_id)
  where factory.workspace_id = target_workspace_id and factory.is_default
  order by activation.activation_number desc limit 1;
  if active_digest is null or active_digest is distinct from expected_factory_definition_digest then
    raise exception 'The active factory definition changed.' using errcode = 'P0003';
  end if;

  if source_session_id is null then
    return query select * from public.create_session_once_with_first_job(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      session_linear_issue_id, session_linear_issue_url, session_github_repository_id,
      selected_pipeline_id, selected_stage_ids);
  else
    return query select * from public.restart_session_once_with_first_job(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash, source_session_id,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      session_linear_issue_id, session_linear_issue_url, session_github_repository_id,
      selected_pipeline_id, selected_stage_ids);
  end if;
end;
$$;
revoke all on function public.create_confirmed_factory_session_once_with_first_job(
  uuid,uuid,uuid,text,text,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[],uuid
) from public, anon, authenticated;
grant execute on function public.create_confirmed_factory_session_once_with_first_job(
  uuid,uuid,uuid,text,text,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[],uuid
) to service_role;
