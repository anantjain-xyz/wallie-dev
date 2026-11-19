-- An observation names a source change independently of when GitHub supplies
-- its merge proof. Keep raw reports and compute the exact link from both current
-- evidence sets, so late observations and corrections converge in either order.
create view internal.current_factory_linked_deployment_deliveries with (security_invoker = true) as
select report.workspace_id, report.factory_id, report.repository_id, report.environment,
  report.deployment_id, report.observation_id as deployment_observation_id, report.revision,
  report.source_sha, report.authoritative_occurred_at as deployed_at, report.observed_at as deployment_observed_at,
  candidate.session_id, candidate.canonical_merge_id, candidate.merge_observation_id,
  candidate.merged_at, candidate.merge_observed_at
from internal.factory_current_deployment_observations report
cross join lateral (
  select match.*, count(*) over () as match_count
  from (
    select merge.session_id, merge.id as canonical_merge_id, merge.observation_id as merge_observation_id,
      merge.merged_at, merge.observed_at as merge_observed_at
    from internal.current_factory_canonical_pull_request_merges merge
    where (merge.workspace_id, merge.factory_id, merge.repository_id, merge.merge_commit_sha) =
      (report.workspace_id, report.factory_id, report.repository_id, report.source_sha)
      and merge.status = 'observed'
    limit 2
  ) match
) candidate
where report.outcome = 'succeeded'
  and candidate.match_count = 1
  and report.authoritative_occurred_at >= candidate.merged_at;

revoke all on internal.current_factory_linked_deployment_deliveries from public, anon, authenticated, service_role;

comment on view internal.current_factory_linked_deployment_deliveries is
  'Latest successful reports with trusted provider time and exactly one current canonical merge for the same workspace, factory, repository, and commit. Both observation IDs retain the exact delivery evidence.';
