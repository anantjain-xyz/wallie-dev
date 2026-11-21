create table internal.factory_benchmark_trial_diffs (
  trial_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  job_id uuid not null,
  run_id uuid not null,
  attempt_count integer not null check (attempt_count > 0),
  input_commit_sha text not null check (input_commit_sha ~ '^[a-f0-9]{40}$'),
  input_tree_sha text not null check (input_tree_sha ~ '^[a-f0-9]{40}$'),
  output_commit_sha text not null check (output_commit_sha ~ '^[a-f0-9]{40}$'),
  output_tree_sha text not null check (output_tree_sha ~ '^[a-f0-9]{40}$'),
  patch text not null check (octet_length(patch) <= 65536),
  patch_sha256 text not null check (patch_sha256 = encode(sha256(convert_to(patch,'UTF8')),'hex')),
  created_at timestamptz not null default clock_timestamp(),
  check (input_commit_sha <> output_commit_sha),
  foreign key (workspace_id,factory_id,trial_id)
    references public.factory_benchmark_trials(workspace_id,factory_id,id) on delete cascade
);
alter table internal.factory_benchmark_trial_diffs enable row level security;
revoke all on internal.factory_benchmark_trial_diffs from public, anon, authenticated, service_role;

create function internal.preserve_factory_benchmark_trial_diff()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factory_benchmark_trials trial where (trial.workspace_id,trial.factory_id,trial.id) =
      (old.workspace_id,old.factory_id,old.trial_id)
  ) then return old; end if;
  raise exception 'A staged benchmark diff is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_benchmark_trial_diff() from public, anon, authenticated, service_role;
create trigger preserve_factory_benchmark_trial_diff before update or delete on internal.factory_benchmark_trial_diffs
  for each row execute function internal.preserve_factory_benchmark_trial_diff();

-- A staged patch becomes visible only if this attempt adopts the same result.
create function public.stage_factory_benchmark_trial_diff(
  p_trial_id uuid,p_job_id uuid,p_attempt_count integer,p_run_id uuid,
  p_input_commit_sha text,p_input_tree_sha text,p_output_commit_sha text,p_output_tree_sha text,
  p_patch text,p_patch_sha256 text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare trial public.factory_benchmark_trials;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_patch is null or octet_length(p_patch) > 65536
    or p_patch_sha256 is distinct from encode(sha256(convert_to(p_patch,'UTF8')),'hex')
    or p_input_commit_sha = p_output_commit_sha
    or exists (select 1 from unnest(array[p_input_commit_sha,p_input_tree_sha,p_output_commit_sha,p_output_tree_sha]) sha(value)
      where not coalesce(value ~ '^[a-f0-9]{40}$',false))
  then raise exception 'Benchmark diff content or revision identity is invalid.' using errcode = '22023'; end if;

  trial := internal.lock_factory_benchmark_trial(p_trial_id,p_job_id);
  if trial.id is null or (trial.run_id,trial.attempt_count,trial.status) is distinct from (p_run_id,p_attempt_count,'running')
    or trial.deadline_at <= clock_timestamp()
    or not exists (
      select 1 from public.agent_jobs job join public.agent_runs run on
        (run.workspace_id,run.session_id,run.agent_job_id,run.attempt_count) = (job.workspace_id,job.session_id,job.id,job.attempt_count)
      where (job.workspace_id,job.session_id,job.id,job.attempt_count,run.id) =
        (trial.workspace_id,trial.session_id,p_job_id,p_attempt_count,p_run_id)
        and job.status in ('started','running') and run.status = 'running'
    ) or not exists (
      select 1 from public.factory_benchmark_task_inputs pin
      where (pin.workspace_id,pin.factory_id,pin.task_id,pin.checkout_sha) =
        (trial.workspace_id,trial.factory_id,trial.task_id,p_input_commit_sha)
    ) then return false; end if;

  insert into internal.factory_benchmark_trial_diffs (
    trial_id,workspace_id,factory_id,job_id,run_id,attempt_count,
    input_commit_sha,input_tree_sha,output_commit_sha,output_tree_sha,patch,patch_sha256
  ) values (
    trial.id,trial.workspace_id,trial.factory_id,p_job_id,p_run_id,p_attempt_count,
    p_input_commit_sha,p_input_tree_sha,p_output_commit_sha,p_output_tree_sha,p_patch,p_patch_sha256
  ) on conflict (trial_id) do nothing;
  return found or exists (
    select 1 from internal.factory_benchmark_trial_diffs retained
    where (retained.workspace_id,retained.factory_id,retained.trial_id,retained.job_id,retained.run_id,retained.attempt_count,
        retained.input_commit_sha,retained.input_tree_sha,retained.output_commit_sha,retained.output_tree_sha,
        retained.patch,retained.patch_sha256) =
      (trial.workspace_id,trial.factory_id,trial.id,p_job_id,p_run_id,p_attempt_count,
        p_input_commit_sha,p_input_tree_sha,p_output_commit_sha,p_output_tree_sha,p_patch,p_patch_sha256)
  );
end;
$$;
revoke all on function public.stage_factory_benchmark_trial_diff(uuid,uuid,integer,uuid,text,text,text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.stage_factory_benchmark_trial_diff(uuid,uuid,integer,uuid,text,text,text,text,text,text) to service_role;
