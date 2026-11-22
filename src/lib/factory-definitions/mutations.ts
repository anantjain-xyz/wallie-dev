import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database, Tables } from "@/lib/supabase/database.types";

import { factoryActivationRequirements, loadFactoryDefinitionCatalog } from "./authority";
import {
  compileFactoryDefinition,
  factoryComponentRevisionsForBundle,
  factoryComponentRevisionsForSource,
  type FactoryDefinitionDiagnostic,
  type FactoryDefinitionSource,
} from "./compiler";
import {
  archiveRemovedFactoryStages,
  catalogForStoredFactoryDefinition,
  latestFactoryDraft,
  loadActivatedFactoryArchiveBase,
  readFactorySettingsMetadata,
  type RoutingDraftWrite,
  saveSettingsFactoryDraft,
} from "./settings-persistence";
import { selectFactory, selectStoredFactoryDefinition } from "./storage";
import {
  readCompiledFactoryDefinition,
  recompileStoredFactoryDefinition,
} from "./stored-definition";

export type FactoryDefinitionMutation =
  | {
      action: "draft";
      expectedActivationNumber: number;
      expectedDraftId?: string | null;
      source: FactoryDefinitionSource;
    }
  | { action: "publish"; expectedActivationNumber: number; draftId: string }
  | { action: "activate-routing"; expectedActivationNumber: number; draftId: string }
  | { action: "rollback"; expectedActivationNumber: number; revisionId: string };

export type FactoryActivationSummary = {
  id: string;
  revisionId: string;
  activationNumber: number;
  previousActivationNumber: number | null;
  createdAt: string;
};

type FactoryDraftSummary = {
  id: string;
  baseActivationNumber: number | null;
  schemaVersion: number;
  canonicalDigest: string;
  createdAt: string;
};

export type FactoryDefinitionMutationFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 500;
  error: string;
  diagnostics?: FactoryDefinitionDiagnostic[];
};

type FactoryMutationResult =
  | { ok: true; result: { draft: FactoryDraftSummary } | { activation: FactoryActivationSummary } }
  | FactoryDefinitionMutationFailure;

type AdminClient = SupabaseClient<Database>;
const reviewedActivationSchema = z.object({
  activationId: z.string().uuid(),
  activationNumber: z.number().int().safe().positive(),
  previousActivationNumber: z.number().int().safe().positive().nullable(),
  revisionId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
});

export async function mutateFactoryDefinition({
  admin,
  workspaceId,
  factoryId,
  actorUserId,
  command,
  routingDraft,
}: {
  admin: AdminClient;
  workspaceId: string;
  factoryId?: string;
  actorUserId: string;
  command: FactoryDefinitionMutation;
  routingDraft?: RoutingDraftWrite;
}): Promise<FactoryMutationResult> {
  const { data: factory, error: factoryError } = await selectFactory(admin, workspaceId, factoryId);
  if (factoryError) return mutationError(factoryError);
  if (!factory) return mutationError({ code: "P0002" });

  const scope = {
    p_workspace_id: workspaceId,
    p_factory_id: factory.id,
    p_actor_user_id: actorUserId,
    p_expected_activation_number: command.expectedActivationNumber,
  };
  try {
    if (command.action === "draft") {
      const draft = await latestFactoryDraft(
        admin,
        workspaceId,
        factory.id,
        command.expectedActivationNumber,
      );
      if (draft.error) return mutationError(draft.error);
      const current = draft.data;
      const currentId = current?.id ?? null;
      if (command.expectedDraftId !== undefined && currentId !== command.expectedDraftId) {
        return mutationError({
          code: "PT409",
          message: "The factory draft changed. Reload before saving.",
        });
      }
      const catalog = await loadFactoryDefinitionCatalog(admin, {
        workspaceId,
        factoryId: factory.id,
        ...factoryComponentRevisionsForSource(command.source),
      });
      const compiled = compileFactoryDefinition(
        command.source,
        current ? catalogForStoredFactoryDefinition(catalog, current) : catalog,
      );
      if (!compiled.ok) return invalidDefinition(compiled.diagnostics);
      const metadata = readFactorySettingsMetadata(current?.settings_metadata);
      const activated =
        !current && command.expectedActivationNumber > 0
          ? await loadActivatedFactoryArchiveBase(
              admin,
              workspaceId,
              factory.id,
              command.expectedActivationNumber,
            )
          : null;
      const base = current ?? activated;
      const baseBundle = base && readCompiledFactoryDefinition(base.definition_json);
      if (baseBundle?.pipelineId === compiled.bundle.pipelineId) {
        const priorArchive = current
          ? metadata.archivedStages
          : readFactorySettingsMetadata(activated?.source?.settings_metadata).archivedStages;
        metadata.archivedStages = archiveRemovedFactoryStages(
          baseBundle,
          compiled.bundle.stages,
          priorArchive ?? [],
        );
      } else {
        delete metadata.pipelineName;
        delete metadata.archivedStages;
      }
      const { data, error } = await saveSettingsFactoryDraft({
        client: admin,
        scope,
        expectedDraftId: currentId,
        compiled,
        metadata,
        routingDraft,
      });
      if (error || !data) return mutationError(error);
      return {
        ok: true,
        result: {
          draft: {
            id: data.id,
            baseActivationNumber: data.base_activation_number,
            schemaVersion: data.schema_version,
            canonicalDigest: data.canonical_digest,
            createdAt: data.created_at,
          },
        },
      };
    }

    const isPublishing = command.action !== "rollback";
    const { data: stored, error: readError } = await selectStoredFactoryDefinition(
      admin,
      workspaceId,
      factory.id,
      isPublishing
        ? { kind: "draft", id: command.draftId }
        : { kind: "revision", id: command.revisionId },
    );
    if (readError) return mutationError(readError);
    if (!stored) return mutationError({ code: "P0002" });

    const bundle = readCompiledFactoryDefinition(stored.definition_json);
    const catalog = await loadFactoryDefinitionCatalog(admin, {
      workspaceId,
      factoryId: factory.id,
      ...factoryComponentRevisionsForBundle(bundle),
    });
    const compiled = recompileStoredFactoryDefinition(
      stored.definition_json,
      stored.canonical_digest,
      catalogForStoredFactoryDefinition(catalog, stored),
    );
    if (!compiled.ok) return invalidDefinition(compiled.diagnostics);
    const { enabledSandboxProviders, requiredProbes } = factoryActivationRequirements(
      compiled.bundle,
    );
    const requirements = {
      ...scope,
      p_enabled_sandbox_providers: enabledSandboxProviders,
      p_required_probes: requiredProbes,
    };
    if (command.action === "activate-routing") {
      const { data, error } = await admin.rpc("activate_reviewed_factory_routing", {
        ...requirements,
        p_draft_id: command.draftId,
      });
      if (error) return mutationError(error);
      const { activationId, ...activation } = reviewedActivationSchema.parse(data);
      return { ok: true, result: { activation: { id: activationId, ...activation } } };
    }
    const { data, error } = isPublishing
      ? await admin.rpc("publish_factory_definition_draft", {
          ...requirements,
          p_draft_id: command.draftId,
        })
      : await admin.rpc("rollback_factory_definition", {
          ...requirements,
          p_revision_id: command.revisionId,
        });
    if (error || !data) return mutationError(error);
    return { ok: true, result: { activation: mapActivation(data) } };
  } catch {
    return mutationError(null);
  }
}

function mapActivation(row: Tables<"factory_definition_activations">): FactoryActivationSummary {
  return {
    id: row.id,
    revisionId: row.revision_id,
    activationNumber: row.activation_number,
    previousActivationNumber: row.previous_activation_number,
    createdAt: row.created_at,
  };
}

export function invalidDefinition(
  diagnostics: FactoryDefinitionDiagnostic[],
): FactoryDefinitionMutationFailure {
  return {
    ok: false,
    status: 422,
    error: "Review the factory definition before retrying.",
    diagnostics,
  };
}

export function mutationError(
  error: { code: string; message?: string } | null,
): FactoryDefinitionMutationFailure {
  switch (error?.code) {
    case "PT409":
      return {
        ok: false,
        status: 409,
        error: error.message ?? "The active definition changed. Reload before retrying.",
      };
    case "PT422":
      return {
        ok: false,
        status: 422,
        error:
          error.message ??
          "The definition no longer matches current workspace authority or capabilities.",
      };
    case "42501":
      return { ok: false, status: 403, error: "Active workspace manager access is required." };
    case "P0002":
      return {
        ok: false,
        status: 404,
        error: "The requested factory definition record is unavailable.",
      };
    case "22023":
    case "23514":
      return { ok: false, status: 400, error: "The factory definition command is invalid." };
    default:
      return {
        ok: false,
        status: 500,
        error: "Could not save or activate the factory definition.",
      };
  }
}
