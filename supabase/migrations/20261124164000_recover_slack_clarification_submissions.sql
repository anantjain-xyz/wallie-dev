-- A nonce returned in Slack's signed private_metadata proves a new modal when
-- views.open succeeded but the acknowledgement-side database binding did not.
alter table internal.slack_clarification_modal_contexts
  add column binding_nonce uuid not null default gen_random_uuid();

drop function public.prepare_slack_clarification_modal(uuid,text,text,text,text,text,text);
drop function public.queue_slack_review_action(text,uuid,text,text,text,text,text,text,text,text,text);

create function public.prepare_slack_clarification_modal(
  p_target_id uuid, p_team_id text, p_app_id text, p_actor_id text,
  p_channel_id text, p_message_ts text, p_thread_ts text default null
) returns table(modal_context_id uuid, encrypted_token text, binding_nonce uuid)
language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare target internal.slack_review_targets; linked internal.connector_actor_links;
begin
  perform internal.assert_checkpoint_publication_service();
  select stored.* into target from internal.slack_review_targets stored where stored.id = p_target_id;
  if not found or target.clarification_id is null
    or not internal.slack_review_container_matches(target, p_team_id, p_app_id, p_channel_id, p_message_ts, p_thread_ts) then
    return;
  end if;
  linked := internal.require_slack_review_human(target, p_actor_id);
  if not internal.slack_review_target_is_current(target) then return; end if;

  select credential.encrypted_token into encrypted_token from internal.connector_installations installation
  join internal.slack_connector_credentials credential
    on (credential.installation_id, credential.credential_id) = (installation.id, installation.legacy_credential_id)
  where (installation.workspace_id, installation.id, installation.generation, installation.external_tenant_id,
    installation.external_installation_id) =
    (target.workspace_id, target.installation_id, target.installation_generation, target.team_id, target.app_id)
    and installation.disconnected_at is null and credential.encrypted_token is not null;
  if not found then return; end if;

  delete from internal.slack_clarification_modal_contexts prior where prior.id in (
    select expired.id from internal.slack_clarification_modal_contexts expired
    where expired.target_id = target.id and expired.expires_at <= clock_timestamp()
    order by expired.expires_at limit 16
  );
  insert into internal.slack_clarification_modal_contexts as context(target_id, actor_id, actor_link_id)
  values (target.id, p_actor_id, linked.id)
  returning context.id, context.binding_nonce into modal_context_id, binding_nonce;
  return next;
exception when insufficient_privilege or sqlstate 'PT404' or sqlstate 'PT409' or sqlstate 'P0002' then
  return;
end;
$$;

create function public.queue_slack_review_action(
  p_action text, p_context_id uuid, p_team_id text, p_app_id text, p_actor_id text, p_delivery_key text,
  p_channel_id text default null, p_message_ts text default null, p_thread_ts text default null,
  p_view_id text default null, p_answer text default null, p_binding_nonce uuid default null
) returns text language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare
  target internal.slack_review_targets;
  context internal.slack_clarification_modal_contexts;
  linked internal.connector_actor_links;
  member public.workspace_members;
  prior internal.slack_review_actions;
  input_hash text;
  answer text;
  queued_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_action = 'approve' then
    if p_view_id is not null or p_answer is not null or p_binding_nonce is not null
      or (p_delivery_key ~ '^approve:[1-9][0-9]{0,11}[.][0-9]{6}$') is not true then return 'denied'; end if;
    select stored.* into target from internal.slack_review_targets stored where stored.id = p_context_id;
    if not found or target.clarification_id is not null
      or not internal.slack_review_container_matches(target, p_team_id, p_app_id, p_channel_id, p_message_ts, p_thread_ts) then
      return 'denied';
    end if;
  elsif p_action = 'answer' then
    answer := btrim(p_answer, E' \t\r\n');
    if num_nonnulls(p_channel_id, p_message_ts, p_thread_ts) <> 0
      or (p_view_id ~ '^V[A-Z0-9]{2,63}$') is not true
      or p_delivery_key is distinct from 'answer:' || p_view_id
      or (length(answer) between 1 and 2000) is not true then return 'denied'; end if;
    select stored.* into context from internal.slack_clarification_modal_contexts stored
    where (stored.id, stored.actor_id) = (p_context_id, p_actor_id);
    if not found then return 'denied'; end if;
    select stored.* into target from internal.slack_review_targets stored
    where (stored.id, stored.team_id, stored.app_id) = (context.target_id, p_team_id, p_app_id)
      and stored.clarification_id is not null;
    if not found then return 'denied'; end if;
  else
    return 'denied';
  end if;

  linked := internal.require_slack_review_human(target, p_actor_id);
  if p_action = 'answer' then
    -- Take the modal lock after the actor authority locks, as modal preparation does.
    select stored.* into context from internal.slack_clarification_modal_contexts stored
    where (stored.id, stored.target_id, stored.actor_id, stored.actor_link_id) =
      (p_context_id, target.id, p_actor_id, linked.id) for no key update;
    if not found or (context.view_id is not null and context.view_id <> p_view_id)
      or ((context.view_id is null or p_binding_nonce is not null)
        and p_binding_nonce is distinct from context.binding_nonce) then return 'denied'; end if;
  end if;
  input_hash := encode(sha256(convert_to(jsonb_build_array(
    p_action, p_context_id, target.id, linked.id, p_view_id, answer
  )::text, 'UTF8')), 'hex');
  select receipt.* into prior from internal.slack_review_actions receipt
  where (receipt.team_id, receipt.app_id, receipt.actor_id, receipt.delivery_key) =
    (p_team_id, p_app_id, p_actor_id, p_delivery_key);
  if not found then
    if (p_action = 'answer' and context.expires_at <= clock_timestamp())
      or not internal.slack_review_target_is_current(target) then return 'stale'; end if;

    if p_action = 'approve' then
      select actor.* into member from public.workspace_members actor
      where (actor.workspace_id, actor.id) = (target.workspace_id, linked.member_id);
      if not internal.can_review_session_stage(target.session_id, target.workspace_id, target.stage_id, member) then
        return 'denied';
      end if;
    elsif context.view_id is null and not public.register_slack_clarification_view(context.id, p_view_id) then
      return 'denied';
    end if;

    insert into internal.slack_review_actions(
      target_id, workspace_id, team_id, app_id, actor_id, actor_link_id, member_id, action, delivery_key, input_hash, answer
    ) values (target.id, target.workspace_id, p_team_id, p_app_id, p_actor_id, linked.id, linked.member_id,
      p_action, p_delivery_key, input_hash, answer)
    on conflict (team_id, app_id, actor_id, delivery_key) do nothing returning id into queued_id;
    if queued_id is not null then return 'queued'; end if;
    select receipt.* into strict prior from internal.slack_review_actions receipt
    where (receipt.team_id, receipt.app_id, receipt.actor_id, receipt.delivery_key) =
      (p_team_id, p_app_id, p_actor_id, p_delivery_key);
  end if;
  return case when prior.input_hash <> input_hash then 'denied'
    when p_action = 'answer' and prior.result is not null and prior.result <> 'applied' then 'stale'
    else 'replayed' end;
exception when insufficient_privilege or sqlstate 'PT404' or sqlstate 'P0002' then
  return 'denied';
when sqlstate 'PT409' then
  return 'stale';
end;
$$;

revoke all on function public.prepare_slack_clarification_modal(uuid,text,text,text,text,text,text),
  public.queue_slack_review_action(text,uuid,text,text,text,text,text,text,text,text,text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_slack_clarification_modal(uuid,text,text,text,text,text,text),
  public.queue_slack_review_action(text,uuid,text,text,text,text,text,text,text,text,text,uuid) to service_role;
