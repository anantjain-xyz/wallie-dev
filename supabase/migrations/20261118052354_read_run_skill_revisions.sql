-- Keep attempt manifests private. The inspector needs only the skill revision
-- identities supplied by the worker, after the caller's session access check.
create function internal.get_run_skill_revisions(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  select case
    when not owner.execute_pinned_definition then '[]'::jsonb
    when resolved.revision_count = cardinality(manifest.definition_skill_ids)
      then coalesce(resolved.revisions, '[]'::jsonb)
    else null
  end
  from public.session_attempt_manifests manifest
  join public.agent_runs run
    on (run.id, run.workspace_id, run.session_id, run.attempt_count) =
       (manifest.run_id, manifest.workspace_id, manifest.session_id, manifest.attempt_count)
  join public.sessions owner on (owner.id, owner.workspace_id) = (run.session_id, run.workspace_id)
  cross join lateral (
    select count(*) as revision_count, jsonb_agg(jsonb_build_object(
      'skillId', skill.id, 'revisionId', revision.id, 'name', skill.name,
      'version', revision.revision_number, 'contentSha256', revision.content_sha256,
      'sourceKind', revision.source_kind
    ) order by reference.ordinality) as revisions
    from unnest(manifest.definition_skill_ids) with ordinality reference(revision_id, ordinality)
    join public.factory_skill_revisions revision
      on (revision.workspace_id, revision.factory_id) = (owner.workspace_id, owner.factory_id)
      and revision.id = case
        when pg_input_is_valid(reference.revision_id, 'uuid') then reference.revision_id::uuid
      end
    join public.factory_skills skill
      on (skill.workspace_id, skill.factory_id, skill.id) =
         (revision.workspace_id, revision.factory_id, revision.skill_id)
  ) resolved
  where manifest.workspace_id = target_workspace_id
    and manifest.run_id = target_run_id
    and manifest.attempt_count = target_attempt_count
    and manifest.renderer_version >= 3
    and auth.uid() is not null
    and internal.can_access_session(owner.id)
$$;

revoke all on function internal.get_run_skill_revisions(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function internal.get_run_skill_revisions(uuid, uuid, integer) to authenticated;

create function public.get_run_skill_revisions(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_run_skill_revisions(target_workspace_id, target_run_id, target_attempt_count)
$$;
revoke all on function public.get_run_skill_revisions(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_run_skill_revisions(uuid, uuid, integer) to authenticated;
