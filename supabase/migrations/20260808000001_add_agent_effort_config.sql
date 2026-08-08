alter table public.workspace_agent_config
  add constraint workspace_agent_config_agent_effort_check
  check (
    key <> 'agent_effort'
    or (
      jsonb_typeof(value_json) = 'string'
      and value_json #>> '{}' in ('low', 'medium', 'high', 'xhigh', 'max')
    )
  );
