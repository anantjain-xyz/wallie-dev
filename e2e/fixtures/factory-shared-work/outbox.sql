begin;
set local request.jwt.claim.role = 'service_role';
set local wallie.m04_workspace = :'workspace_id';
set local wallie.m04_slug = :'workspace_slug';
set local wallie.m04_factory = :'factory_id';
set local wallie.m04_owner = :'owner_id';
set local wallie.m04_writer_token = :'writer_token_id';
set local wallie.m04_writer_grant = :'writer_grant_id';
set local wallie.m04_witness_token = :'witness_token_id';
set local wallie.m04_phase = :'phase';
set local wallie.m04_session = :'session_id';
set local wallie.m04_artifact = :'artifact_id';
set local wallie.m04_writer_signer = :'writer_signer';
set local wallie.m04_witness_signer = :'witness_signer';

create temp table outbox_proof(result jsonb);
do $$
declare
  workspace uuid := current_setting('wallie.m04_workspace')::uuid;
  factory uuid := current_setting('wallie.m04_factory')::uuid;
  owner_id uuid := current_setting('wallie.m04_owner')::uuid;
  writer_token uuid := current_setting('wallie.m04_writer_token')::uuid;
  witness_token uuid := current_setting('wallie.m04_witness_token')::uuid;
  phase text := current_setting('wallie.m04_phase');
  target_session uuid := nullif(current_setting('wallie.m04_session'),'')::uuid;
  artifact uuid := nullif(current_setting('wallie.m04_artifact'),'')::uuid;
  target_subscription uuid;
  target internal.factory_outbound_deliveries;
  event internal.factory_outbound_events;
  claim record;
  envelope record;
  registration record;
  challenge_digest text;
begin
  if not exists(select 1 from public.workspaces w join public.factories f on f.workspace_id=w.id
    where w.id=workspace and f.id=factory and w.slug=current_setting('wallie.m04_slug')
    and w.slug ~ '^m04-qualification-[a-f0-9]{8}$') then raise exception 'Unexpected fixture workspace.'; end if;

  if phase='register' then
    -- Prove the outbound database lifecycle using fixture destinations. DNS and
    -- TLS remain production-only transport checks, with no loopback bypass.
    for registration in select * from (values
      ('writer',writer_token,current_setting('wallie.m04_writer_signer')),
      ('witness',witness_token,current_setting('wallie.m04_witness_signer'))) fixture(name,token,signer)
    loop
      target_subscription := public.create_factory_event_subscription(workspace,factory,owner_id,
        'M04 '||registration.name,'https://receiver.example.test/'||registration.name,
        'machine_token',registration.token,'{review.ready}',registration.signer);
      challenge_digest := encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex');
      perform public.begin_factory_event_subscription_verification(workspace,factory,owner_id,target_subscription,challenge_digest);
      if not public.confirm_factory_event_subscription(workspace,factory,owner_id,target_subscription,challenge_digest) then
        raise exception 'Could not activate the fixture destination.';
      end if;
    end loop;
    insert into outbox_proof values (jsonb_build_object('registered',true));
    return;
  end if;

  select canonical.* into strict event from internal.factory_outbound_events canonical
  where (canonical.workspace_id,canonical.factory_id,canonical.session_id,canonical.event_type,canonical.anchor)=
    (workspace,factory,target_session,'review.ready',artifact::text);
  select destination.id into strict target_subscription from internal.factory_event_subscriptions destination
  where (destination.workspace_id,destination.factory_id,destination.credential_kind,destination.credential_id)=
    (workspace,factory,'machine_token',case when phase='fence' then writer_token else witness_token end);
  select delivery.* into strict target from internal.factory_outbound_deliveries delivery
  where (delivery.workspace_id,delivery.subscription_id,delivery.event_id)=(workspace,target_subscription,event.id);
  if exists(select 1 from internal.factory_outbound_deliveries delivery
    where delivery.workspace_id<>workspace and delivery.status in ('queued','claimed','sending','unknown')
      and (delivery.status<>'unknown' or delivery.next_attempt_at is not null)
      and coalesce(delivery.next_attempt_at,delivery.lease_expires_at,delivery.deadline_at)<=clock_timestamp()) then
    raise exception 'The fixture requires an isolated outbox without unrelated due deliveries.';
  end if;

  if phase='recover' then
    update internal.factory_outbound_deliveries delivery set lease_expires_at=clock_timestamp()-interval '1 second'
    where (delivery.id,delivery.lease_id,delivery.status)=(target.id,target.lease_id,'sending');
    if not found then raise exception 'The abandoned fixture send is missing.'; end if;
    perform public.claim_factory_event_delivery();
    if found then raise exception 'Another delivery is due on this disposable fixture stack.'; end if;
    if not exists(select 1 from public.list_factory_event_deliveries(workspace,factory,owner_id,target_subscription) delivery
      where delivery.id=target.id and delivery.status='unknown' and delivery.last_outcome='unknown'
        and delivery.has_unknown_outcome and delivery.next_attempt_at>clock_timestamp()) then
      raise exception 'The abandoned send did not become an unknown outcome.';
    end if;
    update internal.factory_outbound_deliveries delivery set next_attempt_at=clock_timestamp()-interval '1 second'
    where (delivery.id,delivery.status)=(target.id,'unknown');
    insert into outbox_proof values (jsonb_build_object('backendPid',pg_backend_pid(),'unknown',true));
    return;
  end if;

  -- Preserve the global claimant. Only fixture-owned competing deliveries
  -- are deferred, and an unexpected claim aborts the whole transaction.
  if phase='start' then
    update internal.factory_outbound_deliveries delivery set next_attempt_at=clock_timestamp()+interval '10 minutes'
    where delivery.workspace_id=workspace and delivery.event_id=event.id and delivery.id<>target.id
      and delivery.status='queued';
  elsif phase='fence' then
    update internal.factory_outbound_deliveries delivery set next_attempt_at=clock_timestamp()-interval '1 second'
    where (delivery.id,delivery.status)=(target.id,'queued');
  elsif phase<>'retry' then
    raise exception 'Unknown fixture outbox phase.';
  end if;
  select * into strict claim from public.claim_factory_event_delivery();
  if claim.delivery_id is distinct from target.id then raise exception 'Unexpected fixture delivery claim.'; end if;

  if phase='fence' then
    perform public.revoke_factory_machine_token(workspace,factory,owner_id,
      current_setting('wallie.m04_writer_grant')::uuid,writer_token);
  end if;
  select * into strict envelope from public.begin_factory_event_send(claim.delivery_id,claim.lease_id,claim.subscription_revision);
  if phase='fence' then
    if envelope.outcome<>'revoked' or envelope.payload is not null or envelope.signing_secret_encrypted is not null
      or envelope.attempt_id is not null then raise exception 'A revoked destination acquired send authority.'; end if;
    insert into outbox_proof values (jsonb_build_object('revoked',true,'subscriptionId',target_subscription,
      'deliveryId',target.id,'eventId',event.id));
    return;
  end if;
  if envelope.outcome<>'authorized' or envelope.event_id is distinct from event.id or envelope.payload is distinct from event.payload
    or envelope.signing_secret_encrypted !~ '^v2[.]' or envelope.attempt_id is null then
    raise exception 'The fixture did not acquire the exact send permission.';
  end if;
  if phase='retry' then
    if not public.settle_factory_event_delivery(target.id,claim.lease_id,'delivered',envelope.attempt_id,204) then
      raise exception 'The exact retry did not settle.';
    end if;
    if not exists(select 1 from public.list_factory_event_deliveries(workspace,factory,owner_id,target_subscription) delivery
      where delivery.id=target.id and delivery.status='delivered' and delivery.attempt_count=2
        and delivery.has_unknown_outcome and delivery.last_http_status=204) then
      raise exception 'Delivered retry did not preserve the interrupted attempt history.';
    end if;
  end if;
  insert into outbox_proof values (jsonb_build_object('backendPid',pg_backend_pid(),'subscriptionId',target_subscription,
    'deliveryId',target.id,'eventId',event.id,
    'leaseId',claim.lease_id,'attemptId',envelope.attempt_id,
    'payloadDigest',encode(sha256(convert_to(envelope.payload::text,'UTF8')),'hex')));
end;
$$;
select result from outbox_proof;
commit;
