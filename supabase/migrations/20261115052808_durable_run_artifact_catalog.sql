-- A withholding blocks retrieval without rewriting an immutable evidence receipt.
create table public.session_validation_asset_withholdings (
  asset_id uuid primary key references public.session_validation_assets(id) on delete cascade,
  state text not null check (state in ('redacted', 'expired')),
  recorded_at timestamptz not null default clock_timestamp()
);
alter table public.session_validation_asset_withholdings enable row level security;
revoke all on public.session_validation_asset_withholdings from public, anon, authenticated, service_role;
grant select on public.session_validation_asset_withholdings to authenticated, service_role;
grant insert on public.session_validation_asset_withholdings to service_role;

create policy session_validation_asset_withholdings_read
  on public.session_validation_asset_withholdings for select to authenticated
  using (exists (
    select 1 from public.session_validation_assets asset
    join public.workspaces workspace on workspace.id = asset.workspace_id
    where asset.id = session_validation_asset_withholdings.asset_id
      and workspace.deletion_requested_at is null
  ));

alter policy session_validation_storage_read on storage.objects
  using (bucket_id = 'session-validation-evidence' and exists (
    select 1
    from public.session_validation_assets asset
    join public.session_validation_evidence receipt
      on (receipt.run_id, receipt.workspace_id, receipt.session_id) =
         (asset.run_id, asset.workspace_id, asset.session_id)
    join public.agent_runs run
      on (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
         (receipt.run_id, receipt.workspace_id, receipt.session_id, receipt.job_id, receipt.attempt_count)
    join public.workspaces workspace on workspace.id = asset.workspace_id
    where asset.storage_path = objects.name
      and workspace.deletion_requested_at is null
      and not exists (
        select 1 from public.session_validation_asset_withholdings withholding
        where withholding.asset_id = asset.id
      )
  ));

create function public.list_run_artifacts(
  p_workspace_id uuid,
  p_run_id uuid,
  p_kind text default null,
  p_artifact_id uuid default null,
  p_after_kind text default null,
  p_after_id uuid default null,
  p_limit integer default 21
) returns table (
  artifact_id uuid,
  artifact_kind text,
  label text,
  digest text,
  digest_algorithm text,
  content_type text,
  size_bytes integer,
  availability text,
  downloadable boolean,
  run_id uuid,
  session_id uuid,
  attempt_count integer,
  checkpoint_run_id uuid,
  accepted_commit_sha text,
  validation_run_id uuid,
  validation_commit_sha text,
  validation_tree_sha text,
  recorded_at timestamptz
) language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
declare
  kinds constant text[] := array[
    'stage_markdown', 'checkpoint', 'validation_log', 'validation_report',
    'validation_preview', 'validation_screenshot'
  ];
begin
  if not exists (
    select 1 from public.workspaces w where w.id = p_workspace_id and w.deletion_requested_at is null
  ) then
    raise exception 'Run artifact workspace is unavailable.' using errcode = 'P0002';
  end if;
  if (p_kind is not null and not p_kind = any (kinds))
    or ((p_after_kind is null) <> (p_after_id is null))
    or (p_after_kind is not null and not p_after_kind = any (kinds))
    or (p_kind is not null and p_after_kind is not null and p_kind <> p_after_kind) then
    raise exception 'Invalid run artifact catalog filters.' using errcode = '22023';
  end if;

  return query
  with target_run as materialized (
    select r.id, r.workspace_id, r.session_id, r.agent_job_id, r.attempt_count
    from public.agent_runs r
    join public.sessions s on (s.id, s.workspace_id) = (r.session_id, r.workspace_id)
    where r.id = p_run_id and r.workspace_id = p_workspace_id
  ),
  checkpoint as materialized (
    select c.run_id, c.workspace_id, c.session_id, c.attempt_count, c.repository_id,
      c.output_sha, c.artifact_id, c.bundle_sha256, c.created_at
    from target_run r join public.session_git_checkpoints c
      on (c.run_id, c.workspace_id, c.session_id, c.job_id, c.attempt_count) =
         (r.id, r.workspace_id, r.session_id, r.agent_job_id, r.attempt_count)
  ),
  receipt as materialized (
    select e.run_id, e.workspace_id, e.session_id, e.attempt_count, e.repository_id,
      e.commit_sha, e.validation_tree_sha, e.created_at,
      not exists (
        select 1 from public.session_validation_plans p
        where (p.run_id, p.workspace_id, p.session_id, p.job_id, p.attempt_count, p.repository_id, p.commit_sha) =
              (e.run_id, e.workspace_id, e.session_id, e.job_id, e.attempt_count, e.repository_id, e.commit_sha)
          and p.validation_tree_sha <> e.validation_tree_sha
      ) as tree_matches_plan
    from target_run r join public.session_validation_evidence e
      on (e.run_id, e.workspace_id, e.session_id, e.job_id, e.attempt_count) =
         (r.id, r.workspace_id, r.session_id, r.agent_job_id, r.attempt_count)
  ),
  matched_receipt as (
    select e.* from receipt e join checkpoint c
      on (c.run_id, c.repository_id, c.output_sha) = (e.run_id, e.repository_id, e.commit_sha)
      and e.tree_matches_plan
  ),
  entries as (
    select a.id as entry_id, 'stage_markdown'::text as kind,
      left(a.stage_slug, 128) || ' v' || a.version::text as entry_label,
      null::text as entry_digest, 'sha256'::text as algorithm,
      'text/markdown'::text as mime, octet_length(markdown.body) as bytes,
      case when octet_length(markdown.body) <= 1048576 then 'available' else 'inaccessible' end as state,
      coalesce(octet_length(markdown.body) <= 1048576, false) as can_download,
      c.run_id as owner_run, c.session_id as owner_session, c.attempt_count as owner_attempt,
      c.run_id as accepted_run, c.output_sha as accepted_commit, e.run_id as receipt_run,
      e.commit_sha as receipt_commit, e.validation_tree_sha as receipt_tree,
      a.created_at as observed_at, markdown.body
    from checkpoint c
    join public.session_artifacts a
      on (a.id, a.workspace_id, a.session_id) = (c.artifact_id, c.workspace_id, c.session_id)
    cross join lateral (
      select case when jsonb_typeof(a.artifact_json) = 'string' then a.artifact_json #>> '{}' end as body
    ) markdown
    left join matched_receipt e on true
    where (p_kind is null or p_kind = 'stage_markdown')
      and (p_artifact_id is null or a.id = p_artifact_id)

    union all

    select c.run_id, 'checkpoint', 'Retained checkpoint', coalesce(c.bundle_sha256, c.output_sha),
      case when c.bundle_sha256 is null then 'git_sha1' else 'sha256' end,
      null::text, null::integer, 'retained', false,
      c.run_id, c.session_id, c.attempt_count, c.run_id, c.output_sha, e.run_id,
      e.commit_sha, e.validation_tree_sha, c.created_at, null::text
    from checkpoint c
    left join matched_receipt e on true
    where (p_kind is null or p_kind = 'checkpoint')
      and (p_artifact_id is null or c.run_id = p_artifact_id)

    union all

    select a.id, 'validation_' || a.kind, a.evidence_key, a.sha256, 'sha256', a.content_type,
      a.size_bytes, coalesce(w.state, 'recorded'), w.asset_id is null,
      e.run_id, e.session_id, e.attempt_count, c.run_id, c.output_sha, e.run_id,
      e.commit_sha, e.validation_tree_sha, e.created_at, null::text
    from receipt e
    join public.session_validation_assets a
      on (a.run_id, a.workspace_id, a.session_id) = (e.run_id, e.workspace_id, e.session_id)
    left join checkpoint c
      on (c.run_id, c.repository_id, c.output_sha) = (e.run_id, e.repository_id, e.commit_sha)
      and e.tree_matches_plan
    left join public.session_validation_asset_withholdings w on w.asset_id = a.id
    where (p_kind is null or p_kind = 'validation_' || a.kind)
      and (p_artifact_id is null or a.id = p_artifact_id)
  ),
  page as materialized (
    select x.* from entries x
    where p_after_kind is null
      or (x.kind collate "C", x.entry_id) > (p_after_kind collate "C", p_after_id)
    order by x.kind collate "C", x.entry_id
    limit least(greatest(coalesce(p_limit, 21), 1), 51)
  )
  select p.entry_id, p.kind, p.entry_label,
    case when p.kind = 'stage_markdown' and p.can_download
      then encode(sha256(convert_to(p.body, 'UTF8')), 'hex') else p.entry_digest end,
    p.algorithm, p.mime, p.bytes, p.state, p.can_download,
    p.owner_run, p.owner_session, p.owner_attempt, p.accepted_run, p.accepted_commit, p.receipt_run,
    p.receipt_commit, p.receipt_tree, p.observed_at
  from page p
  order by p.kind collate "C", p.entry_id;
end;
$$;

revoke all on function public.list_run_artifacts(uuid,uuid,text,uuid,text,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_run_artifacts(uuid,uuid,text,uuid,text,uuid,integer)
  to authenticated;
comment on function public.list_run_artifacts(uuid,uuid,text,uuid,text,uuid,integer)
  is 'Exact-run artifact metadata from accepted checkpoints and validation receipts. Never returns Markdown bodies, storage paths, bundles, or credentials.';
