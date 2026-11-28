drop function public.start_factory_workflow_execution(uuid, uuid, uuid, uuid, text, text, text);
drop function public.advance_factory_workflow_generation(uuid, uuid, uuid, bigint);
drop function internal.matches_serial_factory_workflow_plan(jsonb, jsonb, uuid[]);
