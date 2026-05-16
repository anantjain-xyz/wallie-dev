-- Canonicalize agent provider config values to the dashed AgentProvider ids.
-- Existing underscore aliases remain accepted at the API/contract boundary,
-- but persisted config should match the internal provider type.

alter table public.workspace_agent_config
  drop constraint if exists workspace_agent_config_value_json_known_keys;

update public.workspace_agent_config
set value_json = to_jsonb(
  case value_json #>> '{}'
    when 'claude_code' then 'claude-code'
    when 'anthropic_api' then 'anthropic-api'
    else value_json #>> '{}'
  end
)
where key = 'agent_provider'
  and jsonb_typeof(value_json) = 'string'
  and value_json #>> '{}' in ('claude_code', 'anthropic_api');

alter table public.workspace_agent_config
  add constraint workspace_agent_config_value_json_known_keys check (
    case key
      when 'concurrency_limit' then
        jsonb_typeof(value_json) = 'number'
        and (value_json::text)::numeric = floor((value_json::text)::numeric)
        and (value_json::text)::numeric between 1 and 20
      when 'stall_timeout_ms' then
        jsonb_typeof(value_json) = 'number'
        and (value_json::text)::numeric = floor((value_json::text)::numeric)
        and (value_json::text)::numeric between 30000 and 1800000
      when 'max_retries' then
        jsonb_typeof(value_json) = 'number'
        and (value_json::text)::numeric = floor((value_json::text)::numeric)
        and (value_json::text)::numeric between 0 and 10
      when 'agent_provider' then
        jsonb_typeof(value_json) = 'string'
        and value_json #>> '{}' in ('codex', 'claude-code', 'anthropic-api')
      when 'agent_model' then
        jsonb_typeof(value_json) = 'string'
        and length(value_json #>> '{}') between 1 and 100
        and (
          value_json #>> '{}' like 'claude-%'
          or value_json #>> '{}' like 'gpt-%'
          or value_json #>> '{}' like 'o1%'
          or value_json #>> '{}' like 'o3%'
          or value_json #>> '{}' like 'o4%'
        )
      else true
    end
  );
