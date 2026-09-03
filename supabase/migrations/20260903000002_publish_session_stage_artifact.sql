-- Publish a stage artifact and claim awaiting_review in one transaction.
--
-- TypeScript used to CAS the session pointer to `awaiting_review` and then
-- overwrite an unpublished artifact row. A reviewer could approve the stale
-- markdown in that window, after which the worker rewrote the already-approved
-- version. This RPC locks the session, upserts the canonical markdown, and
-- advances the pointer only if the session is still generating at the expected
-- version. A lost generation sees false and does not publish.

create or replace function public.publish_session_stage_artifact(
  p_session_id uuid,
  p_workspace_id uuid,
  p_stage_id uuid,
  p_stage_slug text,
  p_expected_artifact_version integer,
  p_version integer,
  p_artifact_json text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_session public.sessions%rowtype;
begin
  if p_version is null or p_version <= 0 then
    raise exception 'Artifact version must be positive' using errcode = '23514';
  end if;

  if p_expected_artifact_version is null or p_expected_artifact_version < 0 then
    raise exception 'Expected artifact version must be non-negative' using errcode = '23514';
  end if;

  if nullif(btrim(p_stage_slug), '') is null then
    raise exception 'Stage slug must not be blank' using errcode = '23514';
  end if;

  if p_artifact_json is null then
    raise exception 'Artifact markdown is required' using errcode = '23514';
  end if;

  select s.*
  into locked_session
  from public.sessions s
  where s.id = p_session_id
    and s.workspace_id = p_workspace_id
  for update;

  if not found then
    return false;
  end if;

  if locked_session.archived_at is not null then
    return false;
  end if;

  if locked_session.phase_status <> 'in_progress' then
    return false;
  end if;

  if locked_session.current_artifact_version <> p_expected_artifact_version then
    return false;
  end if;

  insert into public.session_artifacts as artifact (
    workspace_id,
    session_id,
    stage_id,
    stage_slug,
    version,
    artifact_json
  )
  values (
    p_workspace_id,
    p_session_id,
    p_stage_id,
    btrim(p_stage_slug),
    p_version,
    to_jsonb(p_artifact_json)
  )
  on conflict (session_id, stage_slug, version)
  do update set artifact_json = excluded.artifact_json;

  update public.sessions s
  set current_artifact_version = p_version,
      phase_status = 'awaiting_review'
  where s.id = p_session_id;

  return true;
end;
$$;

revoke all on function public.publish_session_stage_artifact(
  uuid, uuid, uuid, text, integer, integer, text
) from public, anon, authenticated;

grant execute on function public.publish_session_stage_artifact(
  uuid, uuid, uuid, text, integer, integer, text
) to service_role;
