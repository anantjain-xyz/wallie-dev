revoke all on function public.claim_agent_job(uuid, integer)
  from public, anon, authenticated, service_role;
drop function public.claim_agent_job(uuid, integer);

revoke all on function public.next_session_number(uuid, uuid)
  from public, anon, authenticated, service_role;
drop function public.next_session_number(uuid, uuid);
