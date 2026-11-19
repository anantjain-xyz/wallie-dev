begin;
set local request.jwt.claim.role = 'service_role';
delete from public.workspaces workspace
where workspace.slug=:'workspace_slug' and workspace.slug ~ '^m04-qualification-[a-f0-9]{8}$';
select jsonb_build_object('cleaned',true);
commit;
