insert into internal.factory_outcome_metric_revisions (metric_key, revision, definition) values
  ('canonical_merge_throughput', 1, '{
    "unit":"canonical_prs","population":"unique_verified_merges","observationSources":["pull_requests","lifecycle"],
    "membershipTime":"merged_at","dimensions":["source","person","agent","model","harness","definition"],
    "bucketMembership":"distinct_canonical_merge_with_proven_contributors",
    "unattributed":"unknown_or_unlinked"
  }');

-- The canonical merge fixes the cohort. Contributing runs only come from the
-- exact accepted publication links on the current immutable merge snapshot.
create function internal.factory_throughput_contributions(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz
) returns table (
  merge_id uuid, merge_observation_id uuid, merged_at timestamptz, session_id uuid,
  repository_id uuid, pull_request_number integer, run_id uuid, attempt_count integer,
  request_source text, request_source_receipt_id uuid,
  invoking_actor_member_id uuid, invoking_actor_service_principal_id uuid,
  credential_owner_member_id uuid, credential_owner_service_principal_id uuid, budget_payer_member_id uuid,
  agent_id uuid, agent_prompt_revision_id uuid, model_name text, harness text, worker_runtime text,
  definition_revision_id uuid, definition_digest text, dimension_keys jsonb, dimension_labels jsonb
) language sql stable set search_path = '' as $$
  with cohort as materialized (
    select merge.id, merge.observation_id, merge.merged_at, merge.workspace_id, merge.factory_id,
      merge.session_id, merge.repository_id, merge.pull_request_number
    from internal.current_factory_canonical_pull_request_merges merge
    where (merge.workspace_id, merge.factory_id, merge.status) = (p_workspace_id, p_factory_id, 'observed')
      and merge.merged_at >= p_from and merge.merged_at < p_to
      and merge.merged_at <= merge.observed_at
  ), contribution as (
    select merge.id as merge_id, merge.observation_id as merge_observation_id, merge.merged_at, merge.session_id,
      merge.repository_id, merge.pull_request_number, link.run_id, link.attempt_count,
      coalesce(source.source, 'unknown') as request_source, source.creation_receipt_id as request_source_receipt_id,
      case when coalesce(admission.invoking_actor_service_principal_id,
        receipt.actor_service_principal_id, creation.actor_service_principal_id) is null
        then coalesce(admission.invoking_actor_member_id, receipt.actor_member_id, creation.actor_member_id)
        end as invoking_actor_member_id,
      coalesce(admission.invoking_actor_service_principal_id,
        receipt.actor_service_principal_id, creation.actor_service_principal_id) as invoking_actor_service_principal_id,
      admission.credential_owner_member_id, admission.credential_owner_service_principal_id, admission.budget_payer_member_id,
      agent.id as agent_id, prompt.id as agent_prompt_revision_id, agent.name as agent_name,
      manifest.model_name, manifest.model_provider as harness, manifest.worker_runtime,
      manifest.definition_revision_id, manifest.definition_digest
    from cohort merge
    left join internal.factory_request_attribution source on
      (source.session_id, source.workspace_id, source.factory_id) = (merge.session_id, merge.workspace_id, merge.factory_id)
    left join internal.session_mutation_receipts receipt on
      (receipt.id, receipt.session_id, receipt.workspace_id, receipt.factory_id) =
      (source.creation_receipt_id, merge.session_id, merge.workspace_id, merge.factory_id)
    left join lateral (
      select observation.actor_member_id, observation.actor_service_principal_id
      from internal.factory_outcome_observations observation
      where (observation.session_id, observation.workspace_id, observation.factory_id) =
        (merge.session_id, merge.workspace_id, merge.factory_id) and observation.event_type = 'session.created'
      order by observation.occurred_at, observation.id limit 1
    ) creation on true
    left join public.session_factory_admission_inputs admission on
      (admission.session_id, admission.workspace_id, admission.factory_id) = (merge.session_id, merge.workspace_id, merge.factory_id)
    left join internal.factory_canonical_pull_request_merge_runs link on link.observation_id = merge.observation_id
    left join public.agent_runs run on (run.id, run.attempt_count, run.workspace_id, run.session_id) =
      (link.run_id, link.attempt_count, merge.workspace_id, merge.session_id)
    left join public.session_attempt_manifests manifest on
      (manifest.run_id, manifest.attempt_count, manifest.workspace_id, manifest.session_id, manifest.repository_id) =
      (link.run_id, link.attempt_count, merge.workspace_id, merge.session_id, merge.repository_id)
    -- Older retained runs received a default agent ID during migration.
    -- Require every exact attempt manifest and its contemporaneous identity.
    left join public.factory_agent_prompt_revisions prompt on
      (prompt.id, prompt.agent_id, prompt.workspace_id, prompt.factory_id) =
      (run.agent_prompt_revision_id, run.agent_id, merge.workspace_id, merge.factory_id)
      and prompt.created_at <= manifest.created_at
    left join public.factory_agents agent on
      (agent.id, agent.workspace_id, agent.factory_id) = (prompt.agent_id, merge.workspace_id, merge.factory_id)
      and agent.created_at <= manifest.created_at
  ), classified as (
    select contribution.*,
      case when invoking_actor_service_principal_id is not null then 'service:' || invoking_actor_service_principal_id::text
        when invoking_actor_member_id is not null then 'member:' || invoking_actor_member_id::text
        else 'unknown' end as person_key,
      case when invoking_actor_service_principal_id is not null
        then 'Service principal ' || left(invoking_actor_service_principal_id::text, 8)
        when invoking_actor_member_id is not null
        then 'Workspace member ' || left(invoking_actor_member_id::text, 8)
        else 'Unknown' end as person_label,
      case when run_id is null then 'unlinked' else 'unknown' end as missing_producer,
      case when run_id is null then 'Unlinked' else 'Unknown' end as missing_producer_label
    from contribution
  )
  select fact.merge_id, fact.merge_observation_id, fact.merged_at, fact.session_id, fact.repository_id,
    fact.pull_request_number, fact.run_id, fact.attempt_count, fact.request_source, fact.request_source_receipt_id,
    fact.invoking_actor_member_id, fact.invoking_actor_service_principal_id, fact.credential_owner_member_id,
    fact.credential_owner_service_principal_id, fact.budget_payer_member_id, fact.agent_id,
    case when fact.agent_id is not null then fact.agent_prompt_revision_id end,
    fact.model_name, fact.harness, fact.worker_runtime, fact.definition_revision_id, fact.definition_digest,
    jsonb_build_object(
      'source', fact.request_source, 'person', fact.person_key,
      'agent', coalesce(fact.agent_id::text, fact.missing_producer),
      'model', coalesce('model:' || fact.model_name, fact.missing_producer),
      'harness', coalesce('harness:' || fact.harness, fact.missing_producer),
      'definition', coalesce(fact.definition_revision_id::text, fact.missing_producer)
    ),
    jsonb_build_object(
      'source', case fact.request_source
        when 'browser' then 'Browser' when 'api' then 'API' when 'mcp' then 'MCP' else 'Unknown' end,
      'person', fact.person_label,
      'agent', coalesce(fact.agent_name, fact.missing_producer_label),
      'model', coalesce(fact.model_name, fact.missing_producer_label),
      'harness', coalesce(fact.harness, fact.missing_producer_label),
      'definition', coalesce('Revision ' || left(fact.definition_digest, 12), fact.missing_producer_label)
    )
  from classified fact
$$;
revoke all on function internal.factory_throughput_contributions(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
