import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadFactoryRoutingCanaryAlert } from "@/lib/model-routing/canary-alert-storage";
import { loadFactoryRoutingCanary } from "@/lib/model-routing/canary-storage";
import { routingDraftEvidenceSchema } from "@/lib/model-routing/draft-contracts";
import { routingQualificationStatusSchema } from "@/lib/model-routing/qualification-status";
import { selectReviewedFactoryRoutingActivation } from "@/lib/model-routing/reviewed-activation";
import { loadWorkspaceSandboxOverview } from "@/lib/sandbox-connections/server";
import type { Database } from "@/lib/supabase/database.types";

import { loadFactoryDefinitionCatalog, loadFactoryDefinitionRepositories } from "./authority";
import { compileFactoryDefinition, factoryComponentRevisionsForSource } from "./compiler";
import type {
  FactoryEditorContent,
  FactoryEditorDocument,
  FactoryEditorPreviewRequest,
  FactoryEditorSnapshot,
} from "./editor-contracts";
import {
  invalidDefinition,
  mutationError,
  type FactoryDefinitionMutationFailure,
} from "./mutations";
import { emptyFactorySetupSourceSchema, serialFactoryDefinitionSchema } from "./schema";
import {
  catalogForStoredFactoryDefinition,
  latestFactoryDraft,
  loadStageAnchors,
} from "./settings-persistence";
import { loadSettingsBaseline, type FactoryBaselineSetup } from "./settings-baseline";
import {
  selectCurrentFactoryActivation,
  selectFactory,
  selectFactoryBaselinePipeline,
  selectStoredFactoryDefinition,
  type FactoryDefinitionTarget,
} from "./storage";
import { factoryDefinitionFromBundle, readCompiledFactoryDefinition } from "./stored-definition";

type Client = SupabaseClient<Database>;

async function loadEditorHead(client: Client, workspaceId: string, factoryId?: string) {
  const { data: factory, error: factoryError } = await selectFactory(
    client,
    workspaceId,
    factoryId,
  );
  if (factoryError) throw factoryError;
  if (!factory) return null;

  const { data: activation, error: activationError } = await selectCurrentFactoryActivation(
    client,
    workspaceId,
    factory.id,
  );
  if (activationError) throw activationError;
  const activationNumber = activation?.activation_number ?? 0;
  const { data: draft, error: draftError } = await latestFactoryDraft(
    client,
    workspaceId,
    factory.id,
    activationNumber,
  );
  if (draftError) throw draftError;
  return { factory, activation, activationNumber, draft };
}

async function editorDocument(
  client: Client,
  scope: { workspaceId: string; factoryId: string },
  row: {
    id: string;
    definition_json: string;
    canonical_digest: string;
    created_at: string;
    source_draft_id?: string | null;
    routing_evidence_source_draft_id?: string | null;
  },
  kind: FactoryDefinitionTarget["kind"],
): Promise<FactoryEditorDocument> {
  const bundle = readCompiledFactoryDefinition(row.definition_json);
  if (!bundle) throw new Error("Stored factory definition is invalid.");
  const document: FactoryEditorDocument = {
    id: row.id,
    kind,
    createdAt: row.created_at,
    digest: row.canonical_digest,
    sourceDraftId: row.source_draft_id ?? null,
    source: factoryDefinitionFromBundle(bundle),
    bundle,
  };
  if (kind === "draft" && bundle.modelRouting) {
    const evidenceDraftIds = [row.id];
    if (row.routing_evidence_source_draft_id)
      evidenceDraftIds.push(row.routing_evidence_source_draft_id);
    const { data, error } = await client
      .from("factory_routing_draft_evidence")
      .select("draft_id, evidence")
      .eq("workspace_id", scope.workspaceId)
      .eq("factory_id", scope.factoryId)
      .in("draft_id", evidenceDraftIds);
    if (error) throw error;
    const receipt = data.find(({ draft_id }) => draft_id === row.id) ?? data[0];
    if (receipt) document.routingDraftEvidence = routingDraftEvidenceSchema.parse(receipt.evidence);
  }
  return document;
}

async function readEditorDocument(
  client: Client,
  workspaceId: string,
  factoryId: string,
  target: FactoryDefinitionTarget,
): Promise<FactoryEditorDocument | null> {
  const { data, error } = await selectStoredFactoryDefinition(
    client,
    workspaceId,
    factoryId,
    target,
  );
  if (error) throw error;
  return data ? editorDocument(client, { workspaceId, factoryId }, data, target.kind) : null;
}

async function withRoutingQualification(
  client: Client,
  workspaceId: string,
  factoryId: string,
  document: FactoryEditorDocument,
  activationNumber?: number,
): Promise<FactoryEditorDocument> {
  const target =
    document.kind === "draft"
      ? { p_draft_id: document.id }
      : activationNumber
        ? { p_activation_number: activationNumber }
        : null;
  if (!document.bundle.modelRouting || !target) return document;

  const { data, error } = await client.rpc("get_factory_routing_qualification_status", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    ...target,
  });
  if (error) throw error;
  if (!data) return document;
  const routingQualification = routingQualificationStatusSchema.parse(data);
  const matchesTarget =
    document.kind === "draft"
      ? routingQualification.draftId === document.id
      : routingQualification.revisionId === document.id &&
        routingQualification.activationNumber === activationNumber;
  if (!matchesTarget || routingQualification.definitionDigest !== document.digest) {
    throw new Error("The routing qualification describes a different definition.");
  }
  return { ...document, routingQualification };
}

export async function loadFactoryEditorDocument(
  client: Client,
  workspaceId: string,
  target: FactoryDefinitionTarget,
  factoryId?: string,
  activationNumber?: number,
): Promise<FactoryEditorDocument | null> {
  const { data: factory, error } = await selectFactory(client, workspaceId, factoryId);
  if (error) throw error;
  if (!factory) return null;
  const document = await readEditorDocument(client, workspaceId, factory.id, target);
  if (!document) return null;
  if (target.kind === "draft") {
    return withRoutingQualification(client, workspaceId, factory.id, document);
  }

  const activations = client
    .from("factory_definition_activations")
    .select("activation_number")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factory.id)
    .eq("revision_id", target.id);
  const { data, error: activationError } = await (activationNumber
    ? activations.eq("activation_number", activationNumber).maybeSingle()
    : activations.order("activation_number", { ascending: false }).limit(1).maybeSingle());
  if (activationError) throw activationError;
  if (!data) return activationNumber ? null : document;
  return withRoutingQualification(
    client,
    workspaceId,
    factory.id,
    { ...document, activationNumber: data.activation_number },
    data.activation_number,
  );
}

async function loadEditorBaseline(
  client: Client,
  workspaceId: string,
  factory: { id: string; is_default: boolean },
  setup: FactoryBaselineSetup | undefined,
) {
  const { data: livePipeline, error } = await selectFactoryBaselinePipeline(
    client,
    workspaceId,
    factory,
  );
  if (error) throw error;
  let pipeline = livePipeline;
  if (!pipeline && setup) {
    const fallback = await client
      .from("pipelines")
      .select("id, name, is_default, operating_rules_md")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .order("created_at")
      .order("id")
      .limit(1)
      .maybeSingle();
    if (fallback.error) throw fallback.error;
    pipeline = fallback.data;
  }
  if (!pipeline) return { baseline: null, pipelineAvailable: false };
  if (setup && !setup.repositories.length) return { baseline: null, pipelineAvailable: true };

  const stages = await loadStageAnchors(client, workspaceId, pipeline.id);
  const bundle = await loadSettingsBaseline(
    client,
    workspaceId,
    pipeline.id,
    stages,
    pipeline.operating_rules_md,
    factory,
    setup,
  );
  if (!bundle) return { baseline: null, pipelineAvailable: true };

  // The live baseline seeds authoring. The compiler checks current authority when it is previewed.
  const schema = bundle.stages.length
    ? serialFactoryDefinitionSchema
    : emptyFactorySetupSourceSchema;
  const source = schema.safeParse(factoryDefinitionFromBundle(bundle));
  return { baseline: source.success ? { source: source.data } : null, pipelineAvailable: true };
}

export async function loadFactoryEditorSnapshot(
  client: Client,
  workspaceId: string,
  factoryId?: string,
): Promise<FactoryEditorSnapshot | null> {
  const head = await loadEditorHead(client, workspaceId, factoryId);
  if (!head) return null;
  const { activation, activationNumber, draft, factory } = head;
  const [published, workingDraft, sandbox, repositories] = await Promise.all([
    activation
      ? readEditorDocument(client, workspaceId, factory.id, {
          kind: "revision",
          id: activation.revision_id,
        })
      : null,
    draft ? editorDocument(client, { workspaceId, factoryId: factory.id }, draft, "draft") : null,
    loadWorkspaceSandboxOverview(client, workspaceId),
    factory.is_default ? null : loadFactoryDefinitionRepositories(client, workspaceId, factory.id),
  ]);
  // If the workspace is deleted during the load, the observed activation can no longer be resolved.
  if (activation && !published) return null;
  const readySandboxProviders = sandbox.enabledProviders.filter(
    (provider) => sandbox.connections[provider]?.status === "connected",
  );
  const initialSandboxProvider = readySandboxProviders.includes(sandbox.activeProvider)
    ? sandbox.activeProvider
    : (readySandboxProviders[0] ?? sandbox.activeProvider);
  const workingPipelineId = published?.bundle.pipelineId ?? workingDraft?.bundle.pipelineId;
  const [baselineSetup, workingPipeline] = await Promise.all([
    !activation && !draft
      ? loadEditorBaseline(
          client,
          workspaceId,
          factory,
          repositories ? { repositories, sandboxProvider: initialSandboxProvider } : undefined,
        )
      : null,
    repositories && workingPipelineId
      ? client
          .from("pipelines")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .eq("id", workingPipelineId)
          .maybeSingle()
      : null,
  ]);
  if (workingPipeline?.error) throw workingPipeline.error;
  const pipelineAvailable = baselineSetup?.pipelineAvailable ?? Boolean(workingPipeline?.data);
  const remainingPipeline =
    repositories && workingPipelineId && !pipelineAvailable
      ? await client
          .from("pipelines")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factory.id)
          .limit(1)
          .maybeSingle()
      : null;
  if (remainingPipeline?.error) throw remainingPipeline.error;
  let routingMode: FactoryEditorSnapshot["routingMode"];
  let routingCanary: FactoryEditorSnapshot["routingCanary"];
  let routingCanaryAlertId: FactoryEditorSnapshot["routingCanaryAlertId"];
  if (published?.bundle.modelRouting) {
    const scope = { workspaceId, factoryId: factory.id, activationNumber };
    const [review, canary] = await Promise.all([
      selectReviewedFactoryRoutingActivation(client, scope),
      loadFactoryRoutingCanary(client, scope),
    ]);
    if (review.error) throw review.error;
    routingMode = review.data ? "active" : "shadow";
    routingCanary = canary ?? undefined;
    if (canary) {
      const alert = await loadFactoryRoutingCanaryAlert(client, {
        workspaceId,
        factoryId: factory.id,
        canaryId: canary.id,
      });
      routingCanaryAlertId = alert?.id;
    }
  }
  const [publishedDefinition, draftDefinition] = await Promise.all([
    published
      ? withRoutingQualification(client, workspaceId, factory.id, published, activationNumber)
      : null,
    workingDraft ? withRoutingQualification(client, workspaceId, factory.id, workingDraft) : null,
  ]);
  return {
    activationNumber,
    ...(routingMode ? { routingMode } : {}),
    ...(routingCanary ? { routingCanary } : {}),
    ...(routingCanaryAlertId ? { routingCanaryAlertId } : {}),
    published: publishedDefinition,
    draft: draftDefinition,
    baseline: baselineSetup?.baseline ?? null,
    readySandboxProviders,
    ...(repositories
      ? {
          setup: {
            repositories: repositories
              .map(({ id, full_name }) => ({ id, fullName: full_name }))
              .sort((left, right) => left.fullName.localeCompare(right.fullName)),
            hasPipeline: pipelineAvailable || Boolean(remainingPipeline?.data),
            pipelineAvailable,
            enabledSandboxProviders: sandbox.enabledProviders,
          },
        }
      : {}),
  };
}

export async function previewFactoryEditorDefinition(
  client: Client,
  workspaceId: string,
  request: FactoryEditorPreviewRequest,
  factoryId?: string,
): Promise<{ ok: true; content: FactoryEditorContent } | FactoryDefinitionMutationFailure> {
  const head = await loadEditorHead(client, workspaceId, factoryId);
  if (!head) return mutationError({ code: "P0002" });
  if (
    head.activationNumber !== request.expectedActivationNumber ||
    (head.draft?.id ?? null) !== request.expectedDraftId
  ) {
    return mutationError({
      code: "PT409",
      message: "The factory draft or active revision changed. Reload before previewing.",
    });
  }

  const catalog = await loadFactoryDefinitionCatalog(client, {
    workspaceId,
    factoryId: head.factory.id,
    ...factoryComponentRevisionsForSource(request.source),
  });
  const compiled = compileFactoryDefinition(
    request.source,
    head.draft ? catalogForStoredFactoryDefinition(catalog, head.draft) : catalog,
  );
  if (!compiled.ok) return invalidDefinition(compiled.diagnostics);
  return {
    ok: true,
    content: {
      source: factoryDefinitionFromBundle(compiled.bundle),
      bundle: compiled.bundle,
      digest: compiled.canonicalDigest,
    },
  };
}
