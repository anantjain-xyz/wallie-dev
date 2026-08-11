-- New workspaces use a two-stage plan -> build workflow. Existing pipeline
-- rows are intentionally left untouched so customized and in-flight workflows
-- keep their current stage membership and prompts.

create or replace function internal.default_pipeline_stages()
returns table (
  stage_position integer,
  slug text,
  name text,
  description text,
  prompt_template_md text
)
language sql
immutable
set search_path = ''
as $$
  values
    (
      1,
      'plan',
      'Plan',
      'Frame the problem and lock the plan: spec, acceptance criteria, technical approach, and reproduction signal.',
      '## Plan Request' || E'\n\n' ||
      '{{session.title}}' || E'\n\n' ||
      '## User Request' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Produce a reviewable plan only. Do not modify files, run implementation commands, create branches, install dependencies, or make code changes.' || E'\n\n' ||
      'Cover:' || E'\n' ||
      '- **Problem & goals** — what we are solving and why, plus explicit non-goals.' || E'\n' ||
      '- **Acceptance criteria** — a concrete checklist the Build stage will tick off item by item. If the request names any validation, test plan, or testing steps, copy them verbatim as required items (no optional downgrade). For user-facing work, include a UI walkthrough (launch path → interaction → expected result) as a required criterion.' || E'\n' ||
      '- **Reproduction signal** — the current behavior before any change: the command, output, or UI state that demonstrates the problem (or confirms the feature is absent).' || E'\n' ||
      '- **Technical approach** — key files, data model, API surface, and how the change fits existing patterns.' || E'\n' ||
      '- **Validation plan** — how the change will be proven, including screenshots for user-facing states.' || E'\n' ||
      '- **Risks & open questions.**' || E'\n'
    ),
    (
      2,
      'build',
      'Build',
      'Implement the approved plan, validate it, and open a review-ready PR for human sign-off.',
      'Implement: {{session.title}}' || E'\n\n' ||
      '## User Request' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '{{#if artifact.previousStages.plan}}## Approved Plan' || E'\n\n' ||
      '{{artifact.previousStages.plan}}' || E'\n{{/if}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Implement the change against the approved plan, validate it, and publish a review-ready pull request. Read the codebase first and follow existing patterns. Work in small, focused commits.' || E'\n\n' ||
      '- **Sync first.** Before you start, sync the branch with the repository''s default branch and resolve any conflicts. Never publish on top of a conflicted branch.' || E'\n' ||
      '- **Pick up prior work.** If the branch already has commits from an earlier attempt, reconcile against them — build on what is there and address the feedback specifically rather than redoing committed work.' || E'\n' ||
      '- **Reproduction first.** Confirm the current behavior from the plan''s reproduction signal before changing code.' || E'\n' ||
      '- **Validation is mandatory.** Satisfy every acceptance-criteria and validation item from the plan. Prefer targeted proof that exercises the change; re-run until green before publishing.' || E'\n' ||
      '- **User-facing changes.** Capture full-page screenshots of every state worth reviewing (happy path, loading, error, empty, mobile, hover). If screenshot proof is needed in the PR description, create a screenshot-only commit, add one screenshot proof commit link (`https://github.com/<owner>/<repo>/commit/<screenshot-commit-sha>`), then immediately revert it with `git revert <screenshot-commit-sha>` and push the revert before final review. Do not list or embed each screenshot file; screenshots must never be part of the final PR diff.' || E'\n' ||
      '- **Open the pull request.** Summarize the diff shape, the commits, and the validation evidence produced.' || E'\n' ||
      '- **Stop after publication.** Report the PR and current check state, then return. Do not self-review the PR, wait for automated-review feedback, sweep reviewer comments, or merge the PR.' || E'\n'
    );
$$;

-- A NULL land-stage route means humans merge the PR themselves. New routing
-- rows inherit NULL while existing configured values (including "land") stay
-- unchanged and continue to opt into automated landing.
alter table public.workspace_linear_routing
  alter column land_stage_slug drop not null,
  alter column land_stage_slug drop default;

-- A linked session waiting for a human merge remains open after its terminal
-- artifact is approved. Linear Done performs the successful archive, while a
-- later Rework status can still reopen the terminal stage. Unlinked sessions
-- and workspaces with an automated land stage keep the existing terminal
-- approval behavior.
create or replace function public.approve_session_stage(
  target_session_id uuid,
  expected_workspace_id uuid,
  expected_version integer,
  approver_member_id uuid default null
)
returns table (
  id uuid,
  pipeline_id uuid,
  current_stage_id uuid,
  current_stage_slug text,
  phase_status public.pipeline_phase_status,
  workspace_id uuid,
  linear_issue_url text,
  archived_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  session_pipeline_id uuid;
  current_stage_id_v uuid;
  current_stage_slug_v text;
  current_position integer;
  approver_list uuid[];
  anyone_can_approve_v boolean;
  approver_role public.member_role;
  approver_active boolean;
  approver_workspace uuid;
  next_stage_id uuid;
  approved_at_now timestamptz := now();
begin
  select s.pipeline_id, s.current_stage_id
  into session_pipeline_id, current_stage_id_v
  from public.sessions s
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
    and s.archived_at is null;

  if current_stage_id_v is null then
    return;
  end if;

  select ps.position, ps.slug, ps.approver_member_ids, ps.anyone_can_approve
  into current_position, current_stage_slug_v, approver_list, anyone_can_approve_v
  from public.pipeline_stages ps
  where ps.id = current_stage_id_v;

  if approver_member_id is not null then
    select wm.role, wm.is_active, wm.workspace_id
    into approver_role, approver_active, approver_workspace
    from public.workspace_members wm
    where wm.id = approver_member_id;

    if not coalesce(approver_active, false)
       or approver_workspace is distinct from expected_workspace_id then
      return;
    end if;
  end if;

  if coalesce(anyone_can_approve_v, false) then
    if approver_member_id is null then
      return;
    end if;
  elsif coalesce(array_length(approver_list, 1), 0) > 0 then
    if approver_member_id is null
       or not (approver_member_id = any(approver_list)) then
      return;
    end if;
  else
    if approver_member_id is null
       or approver_role is null
       or approver_role not in ('owner', 'admin') then
      return;
    end if;
  end if;

  update public.sessions s
  set phase_status = 'approved'
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
    and s.archived_at is null;

  if not found then
    return;
  end if;

  insert into public.session_phase_completions (
    session_id,
    workspace_id,
    stage_id,
    stage_slug,
    completed_at,
    completed_by_member_id
  )
  values (
    target_session_id,
    expected_workspace_id,
    current_stage_id_v,
    current_stage_slug_v,
    approved_at_now,
    approver_member_id
  )
  on conflict (session_id, stage_slug) do nothing;

  select ps.id into next_stage_id
  from public.pipeline_stages ps
  join public.session_selected_stages selection
    on selection.stage_id = ps.id
   and selection.session_id = target_session_id
   and selection.workspace_id = expected_workspace_id
  where ps.pipeline_id = session_pipeline_id
    and ps.position > current_position
  order by ps.position asc
  limit 1;

  if next_stage_id is null then
    update public.sessions s
    set archived_at = approved_at_now
    where s.id = target_session_id
      and (
        s.linear_issue_id is null
        or not exists (
          select 1
          from public.workspace_linear_routing routing
          where routing.workspace_id = expected_workspace_id
            and routing.land_stage_slug is null
        )
      );
  else
    update public.sessions s
    set current_stage_id = next_stage_id,
        phase_status = 'in_progress',
        current_artifact_version = 0,
        rejection_count = 0
    where s.id = target_session_id;
  end if;

  return query
    select
      s.id,
      s.pipeline_id,
      s.current_stage_id,
      ps.slug,
      s.phase_status,
      s.workspace_id,
      s.linear_issue_url,
      s.archived_at
    from public.sessions s
    join public.pipeline_stages ps on ps.id = s.current_stage_id
    where s.id = target_session_id;
end;
$$;

revoke all on function public.approve_session_stage(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_session_stage(uuid, uuid, integer, uuid)
  to service_role;
