-- Defend `workspace_agent_config.value_json` from out-of-range values regardless
-- of which caller wrote the row. The Settings UI and `/api/agent-config` route
-- already validate via Zod, but this CHECK constraint catches background jobs,
-- migrations, and direct SQL from getting the table into a state that breaks
-- pipeline runs at orchestration time.
--
-- Constraint mirrors `src/lib/agent-config/contracts.ts`:
--   concurrency_limit  : integer in [1, 20]
--   stall_timeout_ms   : integer in [30_000, 1_800_000]
--   max_retries        : integer in [0, 10]
--   agent_provider     : one of {codex, claude_code}
--   agent_model        : non-empty string starting with claude-, gpt-, o1, o3, or o4
--   (any other key)    : pass-through (forward-compatible for future config keys
--                        until the schema is extended)

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
        and value_json #>> '{}' in ('codex', 'claude_code')
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
