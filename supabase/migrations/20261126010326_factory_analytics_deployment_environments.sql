create function public.list_factory_analytics_deployment_environments(
  p_workspace_id uuid, p_factory_id uuid
) returns text[]
language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.require_factory_flow_window(
    p_workspace_id, p_factory_id, '2000-01-01 00:00:00+00', '2000-01-02 00:00:00+00', null
  );
  return array(
    select distinct deployment.environment
    from internal.factory_deployments deployment
    where (deployment.workspace_id, deployment.factory_id) = (p_workspace_id, p_factory_id)
    order by deployment.environment
  );
end;
$$;

revoke all on function public.list_factory_analytics_deployment_environments(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_analytics_deployment_environments(uuid, uuid)
  to authenticated;
