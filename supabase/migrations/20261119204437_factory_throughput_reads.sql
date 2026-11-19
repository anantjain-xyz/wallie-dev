create function internal.require_factory_throughput_scope(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_dimension text
) returns void language plpgsql stable set search_path = '' as $$
begin
  perform internal.require_factory_flow_window(p_workspace_id, p_factory_id, p_from, p_to, null);
  if p_dimension is null or p_dimension not in ('source', 'person', 'agent', 'model', 'harness', 'definition') then
    raise exception 'Invalid factory throughput dimension.' using errcode = '22023';
  end if;
end;
$$;
revoke all on function internal.require_factory_throughput_scope(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

-- Bucketing applies to the canonical merge. Every exact producing run keeps
-- its own evidence, including values that contributed to a mixed bucket.
create function internal.factory_throughput_bucketed_contributions(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_dimension text
) returns table (
  merge_id uuid, merge_observation_id uuid, merged_at timestamptz, session_id uuid,
  repository_id uuid, pull_request_number integer, run_id uuid, attempt_count integer,
  request_source text, request_source_receipt_id uuid,
  invoking_actor_member_id uuid, invoking_actor_service_principal_id uuid,
  credential_owner_member_id uuid, credential_owner_service_principal_id uuid, budget_payer_member_id uuid,
  agent_id uuid, agent_prompt_revision_id uuid, model_name text, harness text, worker_runtime text,
  definition_revision_id uuid, definition_digest text, dimension_keys jsonb, dimension_labels jsonb,
  raw_bucket_key text, raw_bucket_label text, bucket_key text, bucket_label text
) language sql stable set search_path = '' as $$
  with facts as materialized (
    select contribution.*,
      coalesce(contribution.dimension_keys ->> p_dimension, 'unknown') as raw_bucket_key,
      coalesce(contribution.dimension_labels ->> p_dimension, 'Unknown') as raw_bucket_label
    from internal.factory_throughput_contributions(p_workspace_id, p_factory_id, p_from, p_to) contribution
  ), known as (
    select fact.merge_id,
      count(distinct fact.raw_bucket_key) filter (where fact.raw_bucket_key not in ('unknown', 'unlinked')) as proved_count,
      min(fact.raw_bucket_key) filter (where fact.raw_bucket_key not in ('unknown', 'unlinked')) as proved_key,
      min(fact.raw_bucket_label) filter (where fact.raw_bucket_key not in ('unknown', 'unlinked')) as proved_label,
      bool_or(fact.raw_bucket_key in ('unknown', 'unlinked')) as has_missing,
      bool_or(fact.raw_bucket_key = 'unknown') as has_unknown
    from facts fact group by fact.merge_id
  ), primary_buckets as (
    select known.merge_id,
      case
        when known.proved_count > 0 and known.has_missing then 'partial'
        when known.proved_count > 1 then 'mixed'
        when known.proved_count = 1 then known.proved_key
        when known.has_unknown then 'unknown'
        else 'unlinked'
      end as key,
      case
        when known.proved_count > 0 and known.has_missing then 'Partial'
        when known.proved_count > 1 then 'Mixed'
        when known.proved_count = 1 then known.proved_label
        when known.has_unknown then 'Unknown'
        else 'Unlinked'
      end as label
    from known
  )
  select fact.*, primary_bucket.key, primary_bucket.label
  from facts fact join primary_buckets primary_bucket on primary_bucket.merge_id = fact.merge_id
$$;
revoke all on function internal.factory_throughput_bucketed_contributions(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

create function public.get_factory_throughput_breakdown(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_dimension text default 'source'
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform internal.require_factory_throughput_scope(p_workspace_id, p_factory_id, p_from, p_to, p_dimension);

  with facts as materialized (
    select contribution.merge_id, contribution.run_id, contribution.bucket_key, contribution.bucket_label
    from internal.factory_throughput_bucketed_contributions(p_workspace_id, p_factory_id, p_from, p_to, p_dimension) contribution
  ), buckets as materialized (
    select bucket_key, min(bucket_label) as bucket_label,
      count(distinct merge_id) as merge_count, count(distinct run_id) as run_count
    from facts group by bucket_key
  ), totals as (
    select count(distinct merge_id) as merge_count,
      count(distinct merge_id) filter (where bucket_key = 'mixed') as mixed_count,
      count(distinct merge_id) filter (where bucket_key = 'partial') as partial_count,
      (select coalesce(sum(buckets.merge_count), 0) from buckets) as membership_count
    from facts
  ), bucket_page as materialized (
    select * from buckets order by bucket_key limit 250
  ), coverage as (
    select (
        select source.live_from from internal.factory_outcome_capture_coverage source where source.source = 'pull_requests'
      ) as capture_started_at,
      count(*) as unresolved_count
    from public.session_pr_epochs epoch
    join public.sessions session on (session.workspace_id, session.id) = (epoch.workspace_id, epoch.session_id)
    left join internal.current_factory_canonical_pull_request_merges merge
      on (merge.workspace_id, merge.factory_id, merge.epoch_id) = (session.workspace_id, session.factory_id, epoch.id)
    where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
      and epoch.pr_state = 'merged' and (merge.status is distinct from 'observed' or merge.merged_at > merge.observed_at)
      and epoch.created_at < p_to and (epoch.pr_updated_at is null or epoch.pr_updated_at >= p_from)
  )
  select jsonb_build_object(
    'dimension', p_dimension, 'metricKey', 'canonical_merge_throughput', 'metricRevision', 1,
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'observedMergeCount', totals.merge_count, 'mixedMergeCount', totals.mixed_count, 'partialMergeCount', totals.partial_count,
    'bucketMembershipCount', totals.membership_count,
    'bucketCount', (select count(*) from buckets),
    'bucketsTruncated', (select count(*) > 250 from buckets),
    'omittedBucketMembershipCount', totals.membership_count - (
      select coalesce(sum(bucket_page.merge_count), 0) from bucket_page
    ),
    'buckets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', bucket.bucket_key, 'label', bucket.bucket_label,
        'mergeCount', bucket.merge_count, 'runCount', bucket.run_count
      ) order by bucket.bucket_key) from bucket_page bucket
    ), '[]'::jsonb),
    'coverage', jsonb_build_object(
      'captureStartedAt', coverage.capture_started_at, 'unresolvedMergeCount', coverage.unresolved_count,
      'partial', coverage.capture_started_at is null or p_from < coverage.capture_started_at
        or p_to > statement_timestamp() or coverage.unresolved_count > 0
    ),
    'evaluatedAt', statement_timestamp()
  ) into result
  from totals cross join coverage;
  return result;
end;
$$;

create function public.list_factory_throughput_contributions(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_dimension text default 'source',
  p_bucket_key text default null, p_limit integer default 50, p_cursor_at timestamptz default null,
  p_cursor_merge_id uuid default null, p_cursor_run_id uuid default null, p_cursor_attempt_count integer default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
  unlinked_key constant uuid := '00000000-0000-0000-0000-000000000000';
  show_roles boolean;
begin
  perform internal.require_factory_throughput_scope(p_workspace_id, p_factory_id, p_from, p_to, p_dimension);
  show_roles := internal.can_manage_factory(p_workspace_id, p_factory_id);
  if p_limit is null or p_limit not between 1 and 100 or (p_bucket_key is not null
      and (char_length(p_bucket_key) not between 1 and 512 or p_bucket_key ~ '[[:cntrl:]]'))
    or (p_cursor_at is null) <> (p_cursor_merge_id is null)
    or (p_cursor_run_id is null) <> (p_cursor_attempt_count is null)
    or (p_cursor_run_id is not null and p_cursor_at is null)
    or (p_cursor_at is not null and (not isfinite(p_cursor_at) or p_cursor_at < p_from or p_cursor_at >= p_to))
    or p_cursor_attempt_count < 1 then
    raise exception 'Invalid factory throughput filter or cursor.' using errcode = '22023';
  end if;

  with page as materialized (
    select contribution.*,
      coalesce(contribution.run_id, unlinked_key) as cursor_run_key,
      coalesce(contribution.attempt_count, 0) as cursor_attempt_key
    from internal.factory_throughput_bucketed_contributions(p_workspace_id, p_factory_id, p_from, p_to, p_dimension) contribution
    where (p_bucket_key is null or contribution.bucket_key = p_bucket_key)
      and (p_cursor_at is null
        or (contribution.merged_at, contribution.merge_id, coalesce(contribution.run_id, unlinked_key),
          coalesce(contribution.attempt_count, 0)) >
          (p_cursor_at, p_cursor_merge_id, coalesce(p_cursor_run_id, unlinked_key), coalesce(p_cursor_attempt_count, 0)))
    order by contribution.merged_at, contribution.merge_id, cursor_run_key, cursor_attempt_key
    limit p_limit + 1
  ), visible as materialized (
    select * from page order by merged_at, merge_id, cursor_run_key, cursor_attempt_key limit p_limit
  )
  select jsonb_build_object(
    'dimension', p_dimension, 'metricKey', 'canonical_merge_throughput', 'metricRevision', 1,
    'rolesVisibility', case when show_roles then 'full' else 'redacted' end,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bucketKey', fact.bucket_key, 'bucketLabel', fact.bucket_label,
        'rawBucketKey', fact.raw_bucket_key, 'rawBucketLabel', fact.raw_bucket_label,
        'dimensionKeys', fact.dimension_keys, 'dimensionLabels', fact.dimension_labels,
        'mergeId', fact.merge_id, 'mergeObservationId', fact.merge_observation_id, 'mergedAt', fact.merged_at,
        'sessionId', fact.session_id, 'repositoryId', fact.repository_id, 'pullRequestNumber', fact.pull_request_number,
        'runId', fact.run_id, 'attemptCount', fact.attempt_count,
        'requestSource', fact.request_source, 'requestSourceReceiptId', fact.request_source_receipt_id,
        'invokingActorMemberId', fact.invoking_actor_member_id,
        'invokingActorServicePrincipalId', fact.invoking_actor_service_principal_id,
        'credentialOwnerMemberId', case when show_roles then fact.credential_owner_member_id end,
        'credentialOwnerServicePrincipalId', case when show_roles then fact.credential_owner_service_principal_id end,
        'budgetPayerMemberId', case when show_roles then fact.budget_payer_member_id end,
        'agentId', fact.agent_id, 'agentPromptRevisionId', fact.agent_prompt_revision_id,
        'modelName', fact.model_name, 'harness', fact.harness, 'workerRuntime', fact.worker_runtime,
        'definitionRevisionId', fact.definition_revision_id, 'definitionDigest', fact.definition_digest
      ) order by fact.merged_at, fact.merge_id, fact.cursor_run_key, fact.cursor_attempt_key)
      from visible fact
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from page) > p_limit then (
      select jsonb_build_object('at', merged_at, 'mergeId', merge_id, 'runId', run_id, 'attemptCount', attempt_count)
      from visible order by merged_at desc, merge_id desc, cursor_run_key desc, cursor_attempt_key desc limit 1
    ) end
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_factory_throughput_breakdown(uuid, uuid, timestamptz, timestamptz, text),
  public.list_factory_throughput_contributions(
    uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, uuid, integer
  ) from public, anon, authenticated, service_role;
grant execute on function public.get_factory_throughput_breakdown(uuid, uuid, timestamptz, timestamptz, text),
  public.list_factory_throughput_contributions(
    uuid, uuid, timestamptz, timestamptz, text, text, integer, timestamptz, uuid, uuid, integer
  ) to authenticated;
