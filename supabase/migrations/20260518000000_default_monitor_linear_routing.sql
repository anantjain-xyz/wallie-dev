alter table public.workspace_linear_routing
  alter column monitor_stage_slug set default 'monitor';

with default_mappings as (
  select
    '{
      "backlog": ["backlog"],
      "todo": ["todo"],
      "in_progress": ["in progress"],
      "in_review": ["in review"],
      "rework": ["rework"],
      "merging": ["merging"],
      "done": ["done"],
      "canceled": ["canceled", "cancelled", "duplicate"]
    }'::jsonb as db_default,
    '{
      "backlog": ["Backlog"],
      "todo": ["Todo"],
      "in_progress": ["In Progress"],
      "in_review": ["In Review"],
      "rework": ["Rework"],
      "merging": ["Merging"],
      "done": ["Done"],
      "canceled": ["Canceled", "Cancelled", "Duplicate"]
    }'::jsonb as app_default
)
update public.workspace_linear_routing routing
set monitor_stage_slug = 'monitor'
from default_mappings
where routing.monitor_stage_slug is null
  and routing.rework_stage_slug = 'engineering'
  and routing.land_stage_slug = 'land'
  and routing.updated_at = routing.created_at
  and (
    routing.status_mappings = default_mappings.db_default
    or routing.status_mappings = default_mappings.app_default
  )
  and exists (
    select 1
    from public.pipelines pipeline
    join public.pipeline_stages stage on stage.pipeline_id = pipeline.id
    where pipeline.workspace_id = routing.workspace_id
      and pipeline.is_default = true
      and stage.slug = 'monitor'
  );
