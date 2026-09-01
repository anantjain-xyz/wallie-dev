-- OpenCode model ids are `<provider-id>/<model-id>` where the provider id is
-- user-configured in opencode.json (e.g. `opencode-go`, `anthropic`), not just
-- the Zen-hosted `opencode/` prefix. Relax the agent_model CHECK to accept any
-- lowercase provider slug. Total length stays bounded by the 1..100 length
-- gate, so the per-segment quantifiers only need to stay permissive enough not
-- to reject valid short combinations (mirrors AGENT_MODEL_BODY_PATTERN and
-- OPENCODE_PROVIDER_ID_PATTERN in src/lib/agent-config/contracts.ts).

alter table public.workspace_agent_config
  drop constraint if exists workspace_agent_config_value_json_known_keys;

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
        and value_json #>> '{}' in ('codex', 'claude-code', 'cursor', 'opencode')
      when 'agent_model' then
        jsonb_typeof(value_json) = 'string'
        and length(value_json #>> '{}') between 1 and 100
        and (
          value_json #>> '{}' ~ '^[a-z0-9][a-z0-9._-]{0,98}[a-z0-9](\[1m\])?$|^[a-z0-9]$'
          or value_json #>> '{}' ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?/[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$'
        )
      else true
    end
  );
