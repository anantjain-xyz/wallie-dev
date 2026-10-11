-- An application-side workspace read cannot authorize a later service-role
-- write. Keep the existing workspace SHARE admission lock through every setup
-- insert/update, including upserts and webhook reconciliation. Deletion owns
-- the conflicting workspace lock, so only one ordering can commit.
create trigger repository_onboarding_workspace_admission
before insert or update on public.repository_onboarding_status
for each row execute function internal.guard_workspace_work_admission();
