alter table public.session_factory_admission_inputs
  add column routing_decision jsonb,
  add constraint session_admission_routing_decision_format check (
    routing_decision is null or (
      jsonb_typeof(routing_decision) is not distinct from 'object'
      and routing_decision->'version' is not distinct from '1'::jsonb
      and routing_decision->>'mode' is not distinct from 'shadow'
    )
  );

comment on column public.session_factory_admission_inputs.routing_decision is
  'Immutable routing recommendation and provenance recorded before the first job is queued.';

create function internal.pin_session_model_routing_admission()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  owner public.sessions;
  definition jsonb;
  task_class_slug text;
begin
  new.routing_decision := null;
  select session.* into owner from public.sessions session
  where (session.id, session.workspace_id, session.factory_id, session.factory_definition_revision_id) =
    (new.session_id, new.workspace_id, new.factory_id, new.definition_revision_id)
    and session.execution_purpose = 'production' and session.execute_pinned_definition;
  if not found then return new; end if;

  definition := internal.pinned_session_execution_definition(owner);
  if not (definition ? 'modelRouting') then return new; end if;

  select stage.value->>'slug' into task_class_slug
  from jsonb_array_elements(definition->'stages') stage(value)
  where stage.value->>'id' = new.selected_stage_ids[1]::text;
  new.routing_decision := internal.resolve_factory_model_routing(new, owner, task_class_slug);
  return new;
end;
$$;
revoke all on function internal.pin_session_model_routing_admission() from public, anon, authenticated, service_role;
-- The existing guard derives execution grant and credential-owner fields first.
create trigger pin_session_model_routing_admission before insert on public.session_factory_admission_inputs
  for each row execute function internal.pin_session_model_routing_admission();

alter table public.session_attempt_manifests
  add column routing_decision_session_id uuid references public.session_factory_admission_inputs(session_id),
  add constraint attempt_manifest_routing_decision_owner check (routing_decision_session_id = session_id);

create index session_attempt_manifests_routing_decision_idx
  on public.session_attempt_manifests(routing_decision_session_id) where routing_decision_session_id is not null;

comment on column public.session_attempt_manifests.routing_decision_session_id is
  'The exact admission receipt inspected for this attempt. Runtime fields continue to record actual execution.';

create function internal.pin_attempt_model_routing_admission()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  select admission.session_id into new.routing_decision_session_id
  from public.session_factory_admission_inputs admission
  join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) =
    (admission.workspace_id, admission.factory_id, admission.session_id)
  where (admission.workspace_id, admission.session_id, admission.definition_revision_id, admission.definition_digest) =
    (new.workspace_id, new.session_id, new.definition_revision_id, new.definition_digest)
    and owner.execution_purpose = 'production' and owner.execute_pinned_definition
    and admission.routing_decision is not null;
  return new;
end;
$$;
revoke all on function internal.pin_attempt_model_routing_admission() from public, anon, authenticated, service_role;
create trigger pin_attempt_model_routing_admission before insert on public.session_attempt_manifests
  for each row execute function internal.pin_attempt_model_routing_admission();
