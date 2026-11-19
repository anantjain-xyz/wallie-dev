import "server-only";

import { z } from "zod";

import type { GovernanceScope } from "@/features/factory-governance/governance-data";
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
  "id, repository_id, grant_id, grant_version, file_path, status, current_revision_id, upstream_revision, last_successful_sync_at, last_sync_attempt_at";
const sourceRevisionColumns =
  "id, source_id, upstream_revision, upstream_updated_at, media_type, content_bytes, content_sha256, created_at";
const memoryColumns =
  "id, title, source_session_id, source_artifact_id, source_artifact_version, source_run_id, source_attempt_count, source_commit_sha, source_content_sha256, current_revision_id, pending_revision_id, current_approval_id, forgotten_at, created_at";
const memoryRevisionColumns =
  "id, revision_number, content_sha256, expires_at, supersedes_revision_id, created_at";
const decisionColumns = "id, revision_id, action, actor_member_id, created_at";

export type ContextRepositoryOption = {
  grant_id: string;
  grant_version: number;
  repository_id: string;
  repository_full_name: string;
};

export type MemoryIdentity = Pick<
  Tables<"factory_memories">,
  "id" | "current_revision_id" | "pending_revision_id"
>;

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
  const [list, detail, requestedRevision, cursor, choices] = await Promise.all([
    query.after ? requests.gt("id", query.after) : requests,
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
  ]);
  if (list.error || detail?.error || requestedRevision?.error || cursor?.error) {
    throw new Error("Could not load factory context.");
  }
  const source = detail?.data ?? null;
  const items = list.data.slice(0, limit);
  const sourceIds = [...new Set([...items.map(({ id }) => id), ...(source ? [source.id] : [])])];
  const [repo, access, history, current] = await Promise.all([
    source
      ? supabase
          .from("github_repositories")
          .select("full_name")
          .match(owner)
          .eq("id", source.repository_id)
          .maybeSingle()
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
  ]);
  if (history?.error || current?.error) throw new Error("Could not load context revision history.");
  const historyItems = (history?.data ?? []).slice(0, limit);
  return {
    source,
    items,
    repositoryName: repo?.data?.full_name ?? null,
    access: Object.fromEntries(
      (access?.data ?? []).map(({ source_id, status }) => [source_id, status]),
    ),
    revision: requestedRevision?.data ?? current?.data ?? null,
    history: historyItems,
    nextSource: list.data.length > limit ? items.at(-1)?.id : undefined,
    nextRevision: (history?.data?.length ?? 0) > limit ? historyItems.at(-1)?.id : undefined,
    options: (choices?.data ?? []).slice(0, limit) satisfies ContextRepositoryOption[],
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
