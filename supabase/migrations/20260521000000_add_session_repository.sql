alter table public.sessions
  add column if not exists github_repository_id uuid references public.github_repositories(id) on delete set null;

create index if not exists sessions_github_repository_idx
  on public.sessions (github_repository_id);

create or replace function internal.enforce_session_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_member_id uuid;
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.pipelines', new.pipeline_id, 'pipeline_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.pipeline_stages', new.current_stage_id, 'current_stage_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.github_repositories', new.github_repository_id, 'github_repository_id');

  -- For authenticated (non-service_role) inserts, default creator_member_id
  -- to the current workspace member and lock the field on update. Mirrors
  -- the old issues trigger so sessions created from the UI stay attributed
  -- without every client having to wire the member id through.
  if coalesce(auth.role(), '') <> 'service_role' then
    if tg_op = 'INSERT' then
      current_member_id := internal.current_workspace_member_id(new.workspace_id);

      if current_member_id is null then
        raise exception 'Authenticated user is not an active member of workspace %', new.workspace_id
          using errcode = '42501';
      end if;

      if new.creator_member_id is null then
        new.creator_member_id := current_member_id;
      elsif new.creator_member_id <> current_member_id then
        raise exception 'creator_member_id must match the current workspace member'
          using errcode = '42501';
      end if;
    elsif new.creator_member_id is distinct from old.creator_member_id then
      raise exception 'creator_member_id is immutable after insert'
        using errcode = '42501';
    end if;
  end if;

  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.creator_member_id, 'creator_member_id');
  return new;
end;
$$;
