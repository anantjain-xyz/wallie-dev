import "server-only";

import { z } from "zod";

import type { GovernanceScope } from "@/features/factory-governance/governance-data";
import { selectCurrentFactoryActivation } from "@/lib/factory-definitions/storage";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import type { Tables } from "@/lib/supabase/database.types";

const limit = 20;
const uuid = z.string().uuid();
const contextQuery = z
  .strictObject({
    source: uuid.optional(),
    revision: uuid.optional(),
    after: uuid.optional(),
    before: uuid.optional(),
    grantAfter: uuid.optional(),
    repoAfter: uuid.optional(),
  })
  .refine(({ source, revision, before }) => Boolean(source) || (!revision && !before))
  .refine(({ grantAfter, repoAfter }) => Boolean(grantAfter) === Boolean(repoAfter));
const memoryQuery = z.strictObject({
  memory: uuid.optional(),
  revision: uuid.optional(),
  decision: uuid.optional(),
  proposal: uuid.optional(),
  version: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  after: uuid.optional(),
  before: z.coerce.number().int().positive().max(2_147_483_647).optional(),
});

export const parseContextQuery = contextQuery.safeParse;
export const parseMemoryQuery = memoryQuery.safeParse;

const sourceColumns =
  "id, repository_id, github_installation_id, upstream_repository_id, grant_id, grant_version, file_path, status, current_revision_id, last_successful_sync_at, last_sync_attempt_at";
const sourceRevisionColumns =
  "id, source_id, upstream_revision, upstream_updated_at, media_type, content_bytes, content_sha256, created_at, content_purged_at";
const memoryColumns =
  "id, title, source_session_id, source_artifact_id, source_artifact_version, source_run_id, source_attempt_count, source_commit_sha, source_content_sha256, current_revision_id, pending_revision_id, current_approval_id, forgotten_at, created_at";
const memoryRevisionColumns =
  "id, revision_number, content_sha256, expires_at, supersedes_revision_id, created_at";
const decisionColumns = "id, revision_id, action, actor_member_id, created_at";

type ContextGrantName = { principalName: string; expiresAt: string; published: boolean };

export type ContextRepositoryOption = {
  grant_id: string;
  grant_version: number;
  repository_id: string;
  repository_full_name: string;
  grant: ContextGrantName | null;
};

export type MemoryIdentity = Pick<
  Tables<"factory_memories">,
  "id" | "current_revision_id" | "pending_revision_id"
>;

async function loadPublishedContext({ supabase, workspaceId, factory }: GovernanceScope) {
  const activation = await selectCurrentFactoryActivation(supabase, workspaceId, factory.id);
  if (activation.error) return undefined;
  if (!activation.data) return null;
  const stored = await supabase
    .from("factory_definition_revisions")
    .select("definition_json, canonical_digest")
    .match({ workspace_id: workspaceId, factory_id: factory.id, id: activation.data.revision_id })
    .maybeSingle();
  const verified = stored.data
    ? readVerifiedFactoryDefinition(stored.data.definition_json, stored.data.canonical_digest)
    : null;
  if (stored.error || !verified) return undefined;
  return { documents: verified.contextDocuments ?? [], grant: verified.executionGrant };
}

export async function loadContextPage(
  scope: GovernanceScope,
  query: z.output<typeof contextQuery>,
) {
  const { supabase, workspaceId, factory } = scope;
  const owner = { workspace_id: workspaceId, factory_id: factory.id };
  const sources = () => supabase.from("factory_context_sources").select(sourceColumns).match(owner);
  const revisions = () =>
    supabase
      .from("factory_context_source_revisions")
      .select(sourceRevisionColumns)
      .match({ ...owner, source_id: query.source });
  const requests = sources()
    .order("id")
    .limit(limit + 1);
  const [list, detail, requestedRevision, cursor, choices, published] = await Promise.all([
    query.source ? null : query.after ? requests.gt("id", query.after) : requests,
    query.source ? sources().eq("id", query.source).maybeSingle() : null,
    query.source && query.revision ? revisions().eq("id", query.revision).maybeSingle() : null,
    query.source && query.before ? revisions().eq("id", query.before).maybeSingle() : null,
    !query.source && factory.status === "active"
      ? supabase.rpc("list_factory_context_repository_options", {
          target_workspace_id: workspaceId,
          target_factory_id: factory.id,
          target_limit: limit + 1,
          ...(query.grantAfter && query.repoAfter
            ? {
                target_after_grant_id: query.grantAfter,
                target_after_repository_id: query.repoAfter,
              }
            : {}),
        })
      : null,
    loadPublishedContext(scope),
  ]);
  if (list?.error || detail?.error || requestedRevision?.error || cursor?.error) {
    throw new Error("Could not load factory context.");
  }
  const source = detail?.data ?? null;
  const items = (list?.data ?? []).slice(0, limit);
  const visible = source ? [source] : items;
  const sourceIds = visible.map(({ id }) => id);
  const repositoryIds = [...new Set(visible.map(({ repository_id }) => repository_id))];
  const options = (choices?.data ?? []).slice(0, limit);
  const grantIds = [
    ...new Set(source ? [source.grant_id] : options.map(({ grant_id }) => grant_id)),
  ];
  const [repos, access, history, current, grants] = await Promise.all([
    repositoryIds.length
      ? supabase
          .from("github_repositories")
          .select("id, full_name, repo_id, github_installation_id, github_installations!inner(id)")
          .match(owner)
          .eq("is_archived", false)
          .eq("github_installations.suspended", false)
          .in("id", repositoryIds)
      : null,
    sourceIds.length
      ? supabase.rpc("list_factory_context_source_access", {
          target_workspace_id: workspaceId,
          target_factory_id: factory.id,
          target_source_ids: sourceIds,
        })
      : null,
    source
      ? (() => {
          const page = revisions()
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(limit + 1);
          if (!cursor?.data) return page;
          const { id, created_at: createdAt } = cursor.data;
          return page.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`);
        })()
      : null,
    source?.current_revision_id && !query.revision
      ? revisions().eq("id", source.current_revision_id).maybeSingle()
      : null,
    grantIds.length
      ? supabase
          .from("factory_execution_grants")
          .select("id, version, expires_at, service_principals!inner(name)")
          .match(owner)
          .in("id", grantIds)
      : null,
  ]);
  if (history?.error || current?.error) throw new Error("Could not load context revision history.");
  const repositoryNames = Object.fromEntries(
    visible.flatMap((item) => {
      const repo = repos?.data?.find((candidate) => candidate.id === item.repository_id);
      return repo?.repo_id === item.upstream_repository_id &&
        repo.github_installation_id === item.github_installation_id
        ? [[item.id, repo.full_name] as const]
        : [];
    }),
  );
  function grantName(id: string, version: number): ContextGrantName | null {
    const grant = grants?.data?.find((row) => row.id === id && row.version === version);
    return grant
      ? {
          principalName: grant.service_principals.name,
          expiresAt: grant.expires_at,
          published: published?.grant?.id === id && published.grant.version === version,
        }
      : null;
  }
  const historyItems = (history?.data ?? []).slice(0, limit);
  return {
    source,
    items,
    repositoryNames,
    sourceGrant: source ? grantName(source.grant_id, source.grant_version) : null,
    publishedDocuments: published === undefined ? undefined : (published?.documents ?? []),
    access: Object.fromEntries(
      (access?.data ?? []).map(({ source_id, status }) => [source_id, status]),
    ),
    revision: requestedRevision?.data ?? current?.data ?? null,
    history: historyItems,
    nextSource: (list?.data?.length ?? 0) > limit ? items.at(-1)?.id : undefined,
    nextRevision: (history?.data?.length ?? 0) > limit ? historyItems.at(-1)?.id : undefined,
    options: options.map((option) => ({
      ...option,
      grant: grantName(option.grant_id, option.grant_version),
    })) satisfies ContextRepositoryOption[],
    nextOption: (choices?.data?.length ?? 0) > limit ? choices?.data?.[limit - 1] : undefined,
    optionsUnavailable: Boolean(choices?.error),
  };
}

export async function loadMemoryPage(scope: GovernanceScope, query: z.output<typeof memoryQuery>) {
  const { supabase, workspaceId, factory } = scope;
  const owner = { workspace_id: workspaceId, factory_id: factory.id };
  const memories = () => supabase.from("factory_memories").select(memoryColumns).match(owner);
  const listQuery = memories()
    .order("id")
    .limit(limit + 1);
  const [list, detail, proposal] = await Promise.all([
    query.after ? listQuery.gt("id", query.after) : listQuery,
    query.memory ? memories().eq("id", query.memory).maybeSingle() : null,
    query.proposal && query.version && factory.status === "active"
      ? supabase.rpc("has_factory_run_memory_proposal", {
          p_workspace_id: workspaceId,
          p_factory_id: factory.id,
          p_artifact_id: query.proposal,
          p_artifact_version: query.version,
        })
      : null,
  ]);
  if (list.error || detail?.error) throw new Error("Could not load factory memory.");
  const items = list.data.slice(0, limit);
  const memory = detail?.data ?? null;
  const page = { items, nextMemory: list.data.length > limit ? items.at(-1)?.id : undefined };
  if (!memory) return { ...page, detail: null, proposalAvailable: proposal?.data === true };

  const family = { ...owner, memory_id: memory.id };
  const revisions = () =>
    supabase.from("factory_memory_revisions").select(memoryRevisionColumns).match(family);
  const events = () =>
    supabase.from("factory_memory_review_events").select(decisionColumns).match(family);
  const selected = query.revision ?? memory.pending_revision_id ?? memory.current_revision_id;
  const historyQuery = revisions()
    .order("revision_number", { ascending: false })
    .limit(limit + 1);
  const [history, explicit, requestedDecision, session, sourceArtifact] = await Promise.all([
    query.before ? historyQuery.lt("revision_number", query.before) : historyQuery,
    selected ? revisions().eq("id", selected).maybeSingle() : null,
    query.decision && query.revision
      ? events().eq("id", query.decision).eq("revision_id", query.revision).maybeSingle()
      : null,
    supabase
      .from("sessions")
      .select("number")
      .match(owner)
      .eq("id", memory.source_session_id)
      .maybeSingle(),
    supabase
      .from("session_artifacts")
      .select("stage_slug")
      .eq("workspace_id", workspaceId)
      .eq("session_id", memory.source_session_id)
      .eq("id", memory.source_artifact_id)
      .eq("version", memory.source_artifact_version)
      .maybeSingle(),
  ]);
  if (history.error || explicit?.error || requestedDecision?.error) {
    throw new Error("Could not load memory revision history.");
  }
  const revision = selected ? (explicit?.data ?? null) : (history.data[0] ?? null);
  const historyItems = history.data.slice(0, limit);
  const [body, decisions] = await Promise.all([
    revision && !memory.forgotten_at
      ? supabase
          .from("factory_memory_revision_bodies")
          .select("body_md")
          .match(family)
          .eq("revision_id", revision.id)
          .maybeSingle()
      : null,
    revision
      ? events()
          .or(`revision_id.eq.${revision.id},revision_id.is.null`)
          .order("created_at", { ascending: false })
          .order("id")
          .limit(20)
      : null,
  ]);
  if (body?.error || decisions?.error)
    throw new Error("Could not load the selected memory revision.");
  return {
    ...page,
    proposalAvailable: proposal?.data === true,
    detail: {
      memory,
      revision,
      history: historyItems,
      nextRevision: history.data.length > limit ? historyItems.at(-1)?.revision_number : undefined,
      decisions: decisions?.data ?? [],
      requestedDecision: requestedDecision?.data ?? null,
      body: body?.data?.body_md ?? null,
      sourceSessionNumber: session.data?.number ?? null,
      sourceArtifactStage: sourceArtifact.data?.stage_slug ?? null,
    },
  };
}
