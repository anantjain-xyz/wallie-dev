import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadWorkspaceSandboxOverview } from "@/lib/sandbox-connections/server";
import type { Database } from "@/lib/supabase/database.types";

import { loadFactoryDefinitionCatalog } from "./authority";
import { compileFactoryDefinition } from "./compiler";
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
import { serialFactoryDefinitionSchema } from "./schema";
import {
  catalogForStoredFactoryDefinition,
  latestFactoryDraft,
  loadStageAnchors,
} from "./settings-persistence";
import { loadSettingsBaseline } from "./settings-baseline";
import {
  selectCurrentFactoryActivation,
  selectDefaultFactory,
  selectStoredFactoryDefinition,
  type FactoryDefinitionTarget,
} from "./storage";
import { factoryDefinitionFromBundle, readCompiledFactoryDefinition } from "./stored-definition";

type Client = SupabaseClient<Database>;

async function loadEditorHead(client: Client, workspaceId: string) {
  const { data: factory, error: factoryError } = await selectDefaultFactory(client, workspaceId);
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
  return { factoryId: factory.id, activation, activationNumber, draft };
}

function editorDocument(
  row: {
    id: string;
    definition_json: string;
    canonical_digest: string;
    created_at: string;
    source_draft_id?: string | null;
  },
  kind: FactoryDefinitionTarget["kind"],
): FactoryEditorDocument {
  const bundle = readCompiledFactoryDefinition(row.definition_json);
  if (!bundle) throw new Error("Stored factory definition is invalid.");
  return {
    id: row.id,
    kind,
    createdAt: row.created_at,
    digest: row.canonical_digest,
    sourceDraftId: row.source_draft_id ?? null,
    source: factoryDefinitionFromBundle(bundle),
    bundle,
  };
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
  return data ? editorDocument(data, target.kind) : null;
}

export async function loadFactoryEditorDocument(
  client: Client,
  workspaceId: string,
  target: FactoryDefinitionTarget,
): Promise<FactoryEditorDocument | null> {
  const { data: factory, error } = await selectDefaultFactory(client, workspaceId);
  if (error) throw error;
  if (!factory) return null;
  return readEditorDocument(client, workspaceId, factory.id, target);
}

async function loadEditorBaseline(client: Client, workspaceId: string) {
  const { data: pipeline, error } = await client
    .from("pipelines")
    .select("id, operating_rules_md")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw error;
  if (!pipeline) return null;

  const stages = await loadStageAnchors(client, workspaceId, pipeline.id);
  const bundle = await loadSettingsBaseline(
    client,
    workspaceId,
    pipeline.id,
    stages,
    pipeline.operating_rules_md,
  );
  if (!bundle) return null;

  // The live baseline seeds authoring. The compiler checks current authority when it is previewed.
  const source = serialFactoryDefinitionSchema.safeParse(factoryDefinitionFromBundle(bundle));
  return source.success ? { source: source.data } : null;
}

export async function loadFactoryEditorSnapshot(
  client: Client,
  workspaceId: string,
): Promise<FactoryEditorSnapshot | null> {
  const head = await loadEditorHead(client, workspaceId);
  if (!head) return null;
  const { activation, activationNumber, draft, factoryId } = head;
  const [published, baseline, sandbox] = await Promise.all([
    activation
      ? readEditorDocument(client, workspaceId, factoryId, {
          kind: "revision",
          id: activation.revision_id,
        })
      : null,
    !activation && !draft ? loadEditorBaseline(client, workspaceId) : null,
    loadWorkspaceSandboxOverview(client, workspaceId),
  ]);
  // If the workspace is deleted during the load, the observed activation can no longer be resolved.
  if (activation && !published) return null;
  return {
    activationNumber,
    published,
    draft: draft ? editorDocument(draft, "draft") : null,
    baseline,
    readySandboxProviders: sandbox.enabledProviders.filter(
      (provider) => sandbox.connections[provider]?.status === "connected",
    ),
  };
}

export async function previewFactoryEditorDefinition(
  client: Client,
  workspaceId: string,
  request: FactoryEditorPreviewRequest,
): Promise<{ ok: true; content: FactoryEditorContent } | FactoryDefinitionMutationFailure> {
  const head = await loadEditorHead(client, workspaceId);
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
    factoryId: head.factoryId,
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
