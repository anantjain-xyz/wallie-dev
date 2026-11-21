create table internal.factory_benchmark_comparison_exports (
  id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  experiment_id uuid not null,
  requester_member_id uuid not null references public.workspace_members(id) on delete cascade,
  request_id uuid not null,
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  trial_count integer not null check (trial_count between 1 and 10000),
  page_count integer not null check (page_count = (trial_count + 31) / 32),
  candidate_count integer not null check (candidate_count between 1 and trial_count),
  candidate_page_count integer not null check (candidate_page_count = (candidate_count + 31) / 32),
  manifest text not null check (octet_length(manifest) between 1 and 2097152),
  unique (workspace_id, factory_id, requester_member_id, request_id),
  foreign key (workspace_id, factory_id, experiment_id)
    references public.factory_benchmark_experiments(workspace_id, factory_id, id) on delete cascade,
  check (expires_at > captured_at and expires_at <= captured_at + interval '24 hours')
);
create index factory_benchmark_comparison_exports_order_idx
  on internal.factory_benchmark_comparison_exports(workspace_id,factory_id,experiment_id,requester_member_id,captured_at desc,id desc);
create index factory_benchmark_comparison_exports_expiry_idx
  on internal.factory_benchmark_comparison_exports(workspace_id,factory_id,expires_at,id);

create table internal.factory_benchmark_comparison_export_pages (
  export_id uuid not null references internal.factory_benchmark_comparison_exports(id) on delete cascade,
  kind text not null check (kind in ('trials','candidates')),
  ordinal integer not null check (ordinal between 1 and 313),
  payload text not null check (octet_length(payload) between 1 and 1048576),
  primary key (export_id, kind, ordinal)
);
alter table internal.factory_benchmark_comparison_exports enable row level security;
alter table internal.factory_benchmark_comparison_export_pages enable row level security;
revoke all on internal.factory_benchmark_comparison_exports, internal.factory_benchmark_comparison_export_pages
  from public, anon, authenticated, service_role;

create function internal.preserve_factory_benchmark_comparison_export()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'factory_benchmark_comparison_export_pages' then
      if not exists (select 1 from internal.factory_benchmark_comparison_exports export where export.id = old.export_id)
      then return old; end if;
    elsif old.expires_at <= clock_timestamp()
      or not exists (select 1 from public.factory_benchmark_experiments experiment
        where (experiment.workspace_id, experiment.factory_id, experiment.id) = (old.workspace_id, old.factory_id, old.experiment_id))
      or not exists (select 1 from public.workspace_members member where member.id = old.requester_member_id)
      then return old;
    end if;
  end if;
  raise exception 'A captured comparison export is immutable.' using errcode = '23514';
end;
$$;
create trigger preserve_factory_benchmark_comparison_export
  before update or delete on internal.factory_benchmark_comparison_exports
  for each row execute function internal.preserve_factory_benchmark_comparison_export();
create trigger preserve_factory_benchmark_comparison_export_page
  before update or delete on internal.factory_benchmark_comparison_export_pages
  for each row execute function internal.preserve_factory_benchmark_comparison_export();

create function internal.factory_benchmark_comparison_export_receipt(export internal.factory_benchmark_comparison_exports)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('exportId', export.id, 'capturedAt', export.captured_at, 'expiresAt', export.expires_at,
    'trialCount', export.trial_count, 'pageCount', export.page_count,
    'candidateCount', export.candidate_count, 'candidatePageCount', export.candidate_page_count);
$$;

create function internal.factory_benchmark_comparison_export_pages(p_export_id uuid,p_kind text,p_items jsonb)
returns table(ordinal integer, first_key text, last_key text, item_count integer, payload text)
language sql immutable set search_path = '' as $$
  with grouped as (
    select ((row_number - 1) / 32 + 1)::integer as page,
      jsonb_agg(item order by row_number) as items
    from jsonb_array_elements(p_items) with ordinality as rows(item,row_number)
    group by ((row_number - 1) / 32 + 1)
  ), keys as (
    select case p_kind when 'trials' then 'trialId' else 'candidateKey' end as identity_key,
      case p_kind when 'trials' then 'trialRows' else 'candidates' end as payload_key
  )
  select page, (items->0)->>keys.identity_key, (items -> -1)->>keys.identity_key, jsonb_array_length(items),
    jsonb_build_object('schemaVersion', 1, 'exportId', p_export_id, 'ordinal', page, 'kind', p_kind, keys.payload_key, items)::text
  from grouped cross join keys;
$$;

create function public.create_factory_benchmark_comparison_export(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  requester uuid;
  export internal.factory_benchmark_comparison_exports;
  snapshot_id uuid := gen_random_uuid();
  snapshot jsonb;
  rows jsonb;
  candidate_rows jsonb;
  pages jsonb;
  candidate_pages jsonb;
  trial_ids jsonb;
  manifest text;
  as_of timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  requester := internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  if requester is null then raise exception 'Factory comparison is unavailable.' using errcode = '42501'; end if;
  if p_request_id is null then raise exception 'An export request identity is required.' using errcode = '22023'; end if;

  -- Serialize quota checks and capture retries without locking the execution queue.
  perform pg_advisory_xact_lock(hashtextextended('factory-benchmark-comparison-export/' ||
    p_workspace_id::text || '/' || p_factory_id::text, 0));
  if internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id) is distinct from requester
  then raise exception 'Factory comparison is unavailable.' using errcode = '42501'; end if;
  select * into export from internal.factory_benchmark_comparison_exports existing
  where (existing.workspace_id, existing.factory_id, existing.requester_member_id, existing.request_id) =
    (p_workspace_id,p_factory_id,requester,p_request_id);
  if found then
    if export.experiment_id is distinct from p_experiment_id
    then raise exception 'The export request already refers to another comparison.' using errcode = 'PT409'; end if;
    if export.expires_at <= clock_timestamp()
    then raise exception 'This comparison export has expired.' using errcode = 'PT410'; end if;
    return internal.factory_benchmark_comparison_export_receipt(export);
  end if;

  delete from internal.factory_benchmark_comparison_exports expired
  where expired.id in (select old.id from internal.factory_benchmark_comparison_exports old
    where (old.workspace_id,old.factory_id) = (p_workspace_id,p_factory_id) and old.expires_at <= clock_timestamp()
    order by old.expires_at,old.id limit 10);
  if exists (select 1 from internal.factory_benchmark_comparison_exports existing
    where (existing.workspace_id,existing.factory_id) = (p_workspace_id,p_factory_id) and existing.expires_at > clock_timestamp()
    having count(*) >= 100 or count(*) filter (where existing.requester_member_id = requester) >= 10)
  then raise exception 'Too many active comparison exports.' using errcode = 'PT429'; end if;

  as_of := clock_timestamp();
  snapshot := internal.factory_benchmark_comparison_projection(p_workspace_id,p_factory_id,p_experiment_id,as_of,null,null,null,null);
  if snapshot is null then raise exception 'Comparison is unavailable.' using errcode = 'P0002'; end if;
  rows := snapshot->'trialRows';
  candidate_rows := snapshot->'candidates';
  if jsonb_array_length(rows) <> (snapshot#>>'{counts,planned}')::integer
    or jsonb_array_length(candidate_rows) <> (snapshot->>'candidateCount')::integer
  then raise exception 'The comparison snapshot does not cover the frozen matrix.' using errcode = '23514'; end if;

  select jsonb_agg(trial->'trialId' order by position) into trial_ids
  from jsonb_array_elements(rows) with ordinality as entries(trial,position);
  select jsonb_agg(jsonb_build_object('ordinal',page.ordinal,'firstTrialId',page.first_key,
    'lastTrialId',page.last_key,'trialCount',page.item_count,'sizeBytes',octet_length(page.payload),
    'sha256',encode(sha256(convert_to(page.payload,'UTF8')),'hex')) order by page.ordinal)
  into pages from internal.factory_benchmark_comparison_export_pages(snapshot_id,'trials',rows) page;
  select jsonb_agg(jsonb_build_object('ordinal',page.ordinal,'firstCandidateKey',page.first_key,
    'lastCandidateKey',page.last_key,'candidateCount',page.item_count,'sizeBytes',octet_length(page.payload),
    'sha256',encode(sha256(convert_to(page.payload,'UTF8')),'hex')) order by page.ordinal)
  into candidate_pages from internal.factory_benchmark_comparison_export_pages(snapshot_id,'candidates',candidate_rows) page;
  manifest := jsonb_build_object('schemaVersion',1,'exportId',snapshot_id,'workspaceId',p_workspace_id,
    'factoryId',p_factory_id,'experimentId',p_experiment_id,'capturedAt',as_of,'expiresAt',as_of + interval '24 hours',
    'summary',snapshot - array['trialRows','nextCursor','candidates','nextCandidateCursor'],
    'trialIds',trial_ids,'pages',pages,'candidatePages',candidate_pages)::text;

  if internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id) is distinct from requester
  then raise exception 'Factory comparison is unavailable.' using errcode = '42501'; end if;
  insert into internal.factory_benchmark_comparison_exports (
    id,workspace_id,factory_id,experiment_id,requester_member_id,request_id,captured_at,expires_at,trial_count,page_count,
    candidate_count,candidate_page_count,manifest
  ) values (
    snapshot_id,p_workspace_id,p_factory_id,p_experiment_id,requester,p_request_id,as_of,as_of + interval '24 hours',
    jsonb_array_length(rows),jsonb_array_length(pages),jsonb_array_length(candidate_rows),jsonb_array_length(candidate_pages),manifest
  ) returning * into export;
  insert into internal.factory_benchmark_comparison_export_pages(export_id,kind,ordinal,payload)
  select snapshot_id,'trials',page.ordinal,page.payload
  from internal.factory_benchmark_comparison_export_pages(snapshot_id,'trials',rows) page
  union all
  select snapshot_id,'candidates',page.ordinal,page.payload
  from internal.factory_benchmark_comparison_export_pages(snapshot_id,'candidates',candidate_rows) page;
  return internal.factory_benchmark_comparison_export_receipt(export);
end;
$$;

create function public.read_factory_benchmark_comparison_export(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid, p_export_id uuid,
  p_page_ordinal integer default null, p_page_kind text default 'trials'
) returns text language plpgsql stable security definer set search_path = '' as $$
declare requester uuid; export internal.factory_benchmark_comparison_exports; attachment text;
begin
  perform internal.assert_checkpoint_publication_service();
  requester := internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  select * into export from internal.factory_benchmark_comparison_exports existing
  where (existing.workspace_id,existing.factory_id,existing.experiment_id,existing.id,existing.requester_member_id) =
    (p_workspace_id,p_factory_id,p_experiment_id,p_export_id,requester);
  if not found then raise exception 'Comparison export is unavailable.' using errcode = 'P0002'; end if;
  if export.expires_at <= statement_timestamp()
  then raise exception 'This comparison export has expired.' using errcode = 'PT410'; end if;
  if not coalesce(p_page_kind in ('trials','candidates'),false) or (p_page_ordinal is null and p_page_kind <> 'trials')
  then raise exception 'Invalid comparison export page kind.' using errcode = '22023'; end if;
  if p_page_ordinal is null then return export.manifest; end if;

  select page.payload into attachment from internal.factory_benchmark_comparison_export_pages page
  where (page.export_id,page.kind,page.ordinal) = (export.id,p_page_kind,p_page_ordinal);
  if not found then raise exception 'Comparison export page is unavailable.' using errcode = 'P0002'; end if;
  return attachment;
end;
$$;

create function public.list_factory_benchmark_comparison_exports(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid,
  p_before_captured_at timestamptz default null, p_before_export_id uuid default null, p_limit integer default 20
) returns jsonb language plpgsql stable security definer set search_path = '' set timezone = 'UTC' as $$
declare requester uuid; result jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  requester := internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  if requester is null then raise exception 'Factory comparison is unavailable.' using errcode = '42501'; end if;
  if not exists (select 1 from public.factory_benchmark_experiments experiment
    where (experiment.workspace_id,experiment.factory_id,experiment.id) = (p_workspace_id,p_factory_id,p_experiment_id))
  then raise exception 'Comparison is unavailable.' using errcode = 'P0002'; end if;
  if not coalesce(p_limit between 1 and 50,false) or (p_before_captured_at is null) <> (p_before_export_id is null)
    or not coalesce(isfinite(p_before_captured_at),true)
  then raise exception 'Invalid comparison export page.' using errcode = '22023'; end if;

  with page as materialized (
    select existing as item, existing.id, existing.captured_at
    from internal.factory_benchmark_comparison_exports existing
    where (existing.workspace_id,existing.factory_id,existing.experiment_id,existing.requester_member_id) =
      (p_workspace_id,p_factory_id,p_experiment_id,requester)
      and existing.expires_at > statement_timestamp()
      and (p_before_captured_at is null or (existing.captured_at,existing.id) < (p_before_captured_at,p_before_export_id))
    order by existing.captured_at desc,existing.id desc limit p_limit + 1
  ), visible as materialized (
    select * from page order by captured_at desc,id desc limit p_limit
  ), boundary as (
    select * from visible where (select count(*) from page) > p_limit order by captured_at,id limit 1
  )
  select jsonb_build_object('experimentId',p_experiment_id,'items',coalesce((
    select jsonb_agg(internal.factory_benchmark_comparison_export_receipt(item) order by captured_at desc,id desc) from visible
  ), '[]'::jsonb),'nextCursor',(select jsonb_build_object('capturedAt',captured_at,'exportId',id) from boundary))
  into result;
  return result;
end;
$$;

revoke all on function internal.preserve_factory_benchmark_comparison_export(),
  internal.factory_benchmark_comparison_export_receipt(internal.factory_benchmark_comparison_exports),
  internal.factory_benchmark_comparison_export_pages(uuid,text,jsonb),
  public.create_factory_benchmark_comparison_export(uuid,uuid,uuid,uuid,uuid),
  public.read_factory_benchmark_comparison_export(uuid,uuid,uuid,uuid,uuid,integer,text),
  public.list_factory_benchmark_comparison_exports(uuid,uuid,uuid,uuid,timestamptz,uuid,integer)
from public, anon, authenticated, service_role;
grant execute on function public.create_factory_benchmark_comparison_export(uuid,uuid,uuid,uuid,uuid),
  public.read_factory_benchmark_comparison_export(uuid,uuid,uuid,uuid,uuid,integer,text),
  public.list_factory_benchmark_comparison_exports(uuid,uuid,uuid,uuid,timestamptz,uuid,integer) to service_role;
