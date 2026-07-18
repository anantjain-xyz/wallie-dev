-- Session title edits are user-initiated mutations. Keep the grant column-scoped
-- and the row policy membership-scoped so the authenticated server client can
-- perform the write without escalating to the service role.
grant update (title) on public.sessions to authenticated;

create policy sessions_update_title_membership
  on public.sessions
  for update
  to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()))
  with check (workspace_id in (select internal.current_user_workspace_ids()));
