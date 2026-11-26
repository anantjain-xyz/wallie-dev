import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import { withCatalogSignal } from "@/lib/factory-definitions/catalog-query";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import type { WorkflowGraphDefinition } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import {
  workflowReferencePageSize,
  type WorkflowBaseDefinition,
  type WorkflowDatedReferenceCursor,
  type WorkflowEditorCatalog,
  type WorkflowReferencePage,
  type WorkflowReferenceQuery,
} from "./authoring-contracts";
import { workflowEditorReferencePins } from "./editor-reference-pins";
import type { WorkflowTemplateRevision } from "./workflow-templates";

type CatalogScope = {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
};

function referencePage<Row, Choice, Cursor>(
  rows: Row[],
  choice: (row: Row) => Choice,
  cursor: (row: Row) => Cursor,
) {
  const last = rows[workflowReferencePageSize - 1];
  return {
    items: rows.slice(0, workflowReferencePageSize).map(choice),
    nextCursor: rows.length > workflowReferencePageSize && last ? cursor(last) : null,
  };
}

function olderReferenceFilter({ createdAt, id }: WorkflowDatedReferenceCursor) {
  return `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`;
}

function exactPage<Row, Choice>(rows: Row[], choice: (row: Row) => Choice) {
  return { items: rows.map(choice), nextCursor: null };
}

async function hydratePinned<Choice extends { id: string }>(
  page: { items: Choice[] },
  pins: Iterable<string>,
  load: (ids: string[]) => Promise<{ items: Choice[] }>,
) {
  const loaded = new Set(page.items.map(({ id }) => id));
  const missing = [...new Set(pins)].filter((id) => !loaded.has(id));
  const items = [...page.items];
  for (let offset = 0; offset < missing.length; offset += 64) {
    items.push(...(await load(missing.slice(offset, offset + 64))).items);
  }
  return items;
}

async function loadPromptChoices(
  { supabase, workspaceId, factoryId }: CatalogScope,
  after?: WorkflowDatedReferenceCursor,
  pinned?: string[],
) {
  const query = supabase
    .from("factory_agent_prompt_revisions")
    .select("id, created_at, revision_number, factory_agents!inner(name)")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  const page = pinned ? query.in("id", pinned) : query.limit(workflowReferencePageSize + 1);
  const { data, error } = await (after ? page.or(olderReferenceFilter(after)) : page);
  if (error) throw error;
  const choice = (item: (typeof data)[number]) => ({
    id: item.id,
    label: `${item.factory_agents.name} · Revision ${item.revision_number}`,
  });
  return pinned
    ? exactPage(data, choice)
    : referencePage(data, choice, ({ id, created_at }) => ({ id, createdAt: created_at }));
}

async function loadApproverChoices(
  { supabase, workspaceId }: CatalogScope,
  afterId?: string,
  pinned?: string[],
) {
  const query = supabase
    .from("workspace_members")
    .select("id, full_name, username, email")
    .eq("workspace_id", workspaceId)
    .eq("kind", "human")
    .eq("is_active", true)
    .order("id");
  const page = pinned ? query.in("id", pinned) : query.limit(workflowReferencePageSize + 1);
  const { data, error } = await (afterId ? page.gt("id", afterId) : page);
  if (error) throw error;
  const choice = ({ id, full_name, username, email }: (typeof data)[number]) => ({
    id,
    label:
      [...new Set([full_name, username ? `@${username}` : email].filter(Boolean))].join(" · ") ||
      "Unnamed workspace member",
  });
  return pinned ? exactPage(data, choice) : referencePage(data, choice, ({ id }) => ({ id }));
}

async function loadProfileChoices(
  scope: CatalogScope,
  after?: WorkflowDatedReferenceCursor,
  templateRepositoryId?: string,
  pinned?: string[],
) {
  const { supabase, workspaceId, factoryId } = scope;
  const query = supabase
    .from("factory_definition_revisions")
    .select(
      "id, canonical_digest, created_at, definition_json, factory_definition_activations(activation_number, created_at)",
    )
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("activation_number", {
      ascending: false,
      referencedTable: "factory_definition_activations",
    })
    .limit(1, { referencedTable: "factory_definition_activations" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  const request = pinned ? query.in("id", pinned) : query.limit(workflowReferencePageSize + 1);
  const { data, error } = await (after ? request.or(olderReferenceFilter(after)) : request);
  if (error) throw error;
  const toCursor = ({ id, created_at }: (typeof data)[number]) => ({ id, createdAt: created_at });
  const page = pinned ? exactPage(data, (row) => row) : referencePage(data, (row) => row, toCursor);
  const profiles = page.items.flatMap((row) => {
    const definition = readVerifiedFactoryDefinition(row.definition_json, row.canonical_digest);
    return definition ? [{ row, definition }] : [];
  });
  const [prompts, repositories] = await Promise.all([
    hydratePinned(
      { items: [] as { id: string; label: string }[] },
      profiles.flatMap(({ definition }) =>
        definition.implementationAgent ? [definition.implementationAgent.promptRevisionId] : [],
      ),
      (ids) => loadPromptChoices(scope, undefined, ids),
    ),
    loadRepositoryNames(
      scope,
      profiles.map(({ definition }) => definition.repositoryId),
    ),
  ]);
  const promptLabels = new Map(prompts.map(({ id, label }) => [id, label]));
  return {
    nextCursor: page.nextCursor,
    items: profiles.map(({ row, definition }) => {
      const activation = row.factory_definition_activations?.[0];
      const promptRevisionId = definition.implementationAgent?.promptRevisionId;
      const templateRole =
        activation &&
        definition.repositoryId === templateRepositoryId &&
        promptRevisionId &&
        definition.executionGrant &&
        definition.credentialBindingId &&
        !definition.modelRouting
          ? { promptRevisionId, canRunForeman: definition.agent.provider === "codex" }
          : undefined;
      const provider =
        definition.agent.provider === "codex"
          ? "Codex"
          : definition.agent.provider === "claude-code"
            ? "Claude Code"
            : definition.agent.provider;
      const name = (promptRevisionId && promptLabels.get(promptRevisionId)) || "Execution profile";
      const date = activation?.created_at ?? row.created_at;
      return {
        id: row.id,
        digest: row.canonical_digest,
        label: [
          name,
          provider,
          repositories.get(definition.repositoryId),
          activation ? `Activation ${activation.activation_number}` : "Not activated",
          date.slice(0, 10),
        ]
          .filter(Boolean)
          .join(" · "),
        ...(templateRole ? { templateRole } : {}),
      };
    }),
  };
}

async function loadRepositoryNames(
  { supabase, workspaceId, factoryId }: CatalogScope,
  ids: string[],
  onlyActive = false,
) {
  const names = new Map<string, string>();
  const repositories = [...new Set(ids)];
  for (let offset = 0; offset < repositories.length; offset += 64) {
    const query = supabase
      .from("github_repositories")
      .select("id, full_name")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .in("id", repositories.slice(offset, offset + 64));
    const { data, error } = await (onlyActive ? query.eq("is_archived", false) : query);
    if (error) throw error;
    for (const { id, full_name } of data) names.set(id, full_name);
  }
  return names;
}

async function loadWriterChoices(
  scope: CatalogScope,
  base: WorkflowBaseDefinition | null,
  definition: ReturnType<typeof readVerifiedFactoryDefinition>,
  afterId?: string,
  pinned?: string[],
) {
  if (
    !base ||
    !definition?.repositoryId ||
    !definition.executionPolicyRevisionId ||
    !definition.executionGrant
  ) {
    return { items: [], nextCursor: null };
  }
  const { supabase, workspaceId, factoryId } = scope;
  const query = supabase
    .from("factory_execution_grants")
    .select("id, version, github_repository_id")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("execution_policy_revision_id", definition.executionPolicyRevisionId)
    .neq("github_repository_id", definition.repositoryId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("id");
  const request = pinned ? query.in("id", pinned) : query.limit(workflowReferencePageSize + 1);
  const { data, error } = await (afterId ? request.gt("id", afterId) : request);
  if (error) throw error;
  const page = pinned
    ? exactPage(data, (row) => row)
    : referencePage(
        data,
        (row) => row,
        ({ id }) => ({ id, baseActivationId: base.activationId }),
      );
  const byId = await loadRepositoryNames(
    scope,
    page.items.map(({ github_repository_id }) => github_repository_id),
    true,
  );
  return {
    nextCursor: page.nextCursor,
    items: page.items.flatMap(({ id, version, github_repository_id: repositoryId }) => {
      const name = byId.get(repositoryId);
      return name
        ? [{ id, version, repositoryId, label: `${name} · Grant version ${version}` }]
        : [];
    }),
  };
}

/** The caller checks the current manager authority before using the signed-in RLS client. */
export async function loadWorkflowReferencePage(
  scope: CatalogScope,
  query: WorkflowReferenceQuery,
  base: WorkflowBaseDefinition | null,
  template?: WorkflowTemplateRevision | null,
): Promise<WorkflowReferencePage> {
  const { afterId } = query;
  switch (query.catalog) {
    case "prompts":
      return {
        catalog: query.catalog,
        ...(await loadPromptChoices(scope, { id: afterId, createdAt: query.afterCreatedAt })),
      };
    case "approvers":
      return { catalog: query.catalog, ...(await loadApproverChoices(scope, afterId)) };
    case "profiles":
      return {
        catalog: query.catalog,
        ...(await loadProfileChoices(
          scope,
          { id: afterId, createdAt: query.afterCreatedAt },
          template ? (await loadWorkflowBaseDefinition(scope, base))?.repositoryId : undefined,
        )),
      };
    case "writers":
      return {
        catalog: query.catalog,
        ...(await loadWriterChoices(
          scope,
          base,
          await loadWorkflowBaseDefinition(scope, base),
          afterId,
        )),
      };
  }
}

async function loadWorkflowBaseDefinition(
  { supabase, workspaceId, factoryId }: CatalogScope,
  base: WorkflowBaseDefinition | null,
) {
  if (!base) return null;
  const { data, error } = await supabase
    .from("factory_definition_revisions")
    .select("definition_json")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", base.revisionId)
    .eq("canonical_digest", base.digest)
    .maybeSingle();
  if (error) throw error;
  return data ? readVerifiedFactoryDefinition(data.definition_json, base.digest) : null;
}

async function loadTemplateSource(
  { supabase, workspaceId }: CatalogScope,
  definition: ReturnType<typeof readVerifiedFactoryDefinition>,
  template?: WorkflowTemplateRevision | null,
) {
  const stage = definition?.stages.at(-1);
  if (
    !template ||
    !stage ||
    !definition?.repositoryId ||
    !definition.credentialBindingId ||
    !definition.implementationAgent ||
    !definition.executionGrant
  )
    return undefined;
  const { data, error } =
    definition.deliveryPolicyRevisionId && template.id !== "incident-analysis"
      ? await supabase
          .from("delivery_policy_revisions")
          .select("requirements")
          .eq("workspace_id", workspaceId)
          .eq("pipeline_id", definition.pipelineId)
          .eq("id", definition.deliveryPolicyRevisionId)
          .maybeSingle()
      : { data: null, error: null };
  if (error) throw error;
  const policy = deliveryRequirementsSchema.safeParse(data?.requirements);
  const requiredEvidence = policy.success ? policy.data.requiredEvidence : [];
  return {
    label: stage.name,
    anyoneCanApprove: stage.anyoneCanApprove,
    approverMemberIds: stage.approverMemberIds,
    hasRequiredEvidence: requiredEvidence.length > 0,
    canDraftProductScope:
      definition.stages.length === 1 &&
      !(
        policy.success &&
        policy.data.deliveryMode === "code" &&
        policy.data.requireArtifactApprovalForDelivery
      ),
  };
}

export async function loadWorkflowEditorChoices(
  scope: CatalogScope,
  base: WorkflowBaseDefinition | null,
  template?: WorkflowTemplateRevision | null,
  graph?: WorkflowGraphDefinition | null,
): Promise<WorkflowEditorCatalog> {
  const definition = loadWorkflowBaseDefinition(scope, base);
  const [prompts, approvers, profiles, baseChoices] = await Promise.all([
    loadPromptChoices(scope),
    loadApproverChoices(scope),
    template
      ? definition.then((active) => loadProfileChoices(scope, undefined, active?.repositoryId))
      : loadProfileChoices(scope),
    definition.then(async (active) => {
      const [writers, templateSource, repositories] = await Promise.all([
        loadWriterChoices(scope, base, active),
        loadTemplateSource(scope, active, template),
        loadRepositoryNames(scope, active?.executionGrant ? [active.repositoryId] : []),
      ]);
      return {
        active,
        writers,
        templateSource,
        grantRepository: active && repositories.get(active.repositoryId),
      };
    }),
  ]);
  const pins = workflowEditorReferencePins(graph);
  const [promptItems, approverItems, profileItems, writerItems] = await Promise.all([
    hydratePinned(prompts, pins.prompts, (ids) => loadPromptChoices(scope, undefined, ids)),
    hydratePinned(
      approvers,
      [...pins.approvers, ...(baseChoices.templateSource?.approverMemberIds ?? [])],
      (ids) => loadApproverChoices(scope, undefined, ids),
    ),
    hydratePinned(profiles, pins.profiles, (ids) =>
      loadProfileChoices(
        scope,
        undefined,
        template ? baseChoices.active?.repositoryId : undefined,
        ids,
      ),
    ),
    hydratePinned(baseChoices.writers, pins.writers, (ids) =>
      loadWriterChoices(scope, base, baseChoices.active, undefined, ids),
    ),
  ]);
  return {
    prompts: promptItems,
    approvers: approverItems,
    profiles: profileItems,
    grant: baseChoices.active?.executionGrant ?? null,
    ...(baseChoices.grantRepository ? { grantRepository: baseChoices.grantRepository } : {}),
    writers: writerItems,
    ...(baseChoices.templateSource ? { templateSource: baseChoices.templateSource } : {}),
    nextCursors: {
      prompts: prompts.nextCursor,
      approvers: approvers.nextCursor,
      profiles: profiles.nextCursor,
      writers: baseChoices.writers.nextCursor,
    },
  };
}

async function loadWorkflowApprovers(
  admin: SupabaseClient<Database>,
  workspaceId: string,
  approverIds: string[],
  signal?: AbortSignal,
) {
  const approvers: { id: string; workspaceId: string }[] = [];
  const batchSize = 128;
  for (let from = 0; from < approverIds.length; from += batchSize) {
    const { data, error } = await withCatalogSignal(
      admin
        .from("workspace_members")
        .select("id, workspace_id")
        .eq("workspace_id", workspaceId)
        .eq("kind", "human")
        .eq("is_active", true)
        .in("id", approverIds.slice(from, from + batchSize)),
      signal,
    );
    if (error) throw error;
    approvers.push(
      ...(data ?? []).map(({ id, workspace_id }) => ({
        id,
        workspaceId: workspace_id,
      })),
    );
  }
  return approvers;
}

/** The editor and graph enrollment resolve the same scoped prompt and approver references. */
export async function loadWorkflowGraphReferences(
  admin: SupabaseClient<Database>,
  {
    workspaceId,
    factoryId,
    graph,
    signal,
  }: {
    workspaceId: string;
    factoryId: string;
    graph: WorkflowGraphDefinition;
    signal?: AbortSignal;
  },
) {
  const revisionIds = [
    ...new Set(
      graph.nodes.flatMap((node) =>
        node.kind === "review"
          ? [node.reviewerPromptRevisionId]
          : "agentPromptRevisionId" in node
            ? [node.agentPromptRevisionId]
            : [],
      ),
    ),
  ];
  const approverIds = [
    ...new Set(
      graph.nodes.flatMap((node) => (node.kind === "human-gate" ? node.approverMemberIds : [])),
    ),
  ];
  const [prompts, approvers] = await Promise.all([
    revisionIds.length
      ? withCatalogSignal(
          admin
            .from("factory_agent_prompt_revisions")
            .select("id, workspace_id")
            .eq("workspace_id", workspaceId)
            .eq("factory_id", factoryId)
            .in("id", revisionIds),
          signal,
        )
      : { data: [], error: null },
    loadWorkflowApprovers(admin, workspaceId, approverIds, signal),
  ]);
  if (prompts.error) throw prompts.error;
  return {
    agentPromptRevisions: (prompts.data ?? []).map(({ id, workspace_id }) => ({
      id,
      workspaceId: workspace_id,
    })),
    approvers,
  };
}
