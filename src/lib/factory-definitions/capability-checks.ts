import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";
import {
  completeSandboxCapabilityCheck,
  getLatestSandboxCapabilityCheck,
  startSandboxCapabilityCheck,
} from "@/lib/sandbox-capabilities/server";
import type { Database } from "@/lib/supabase/database.types";

import { loadFactoryDefinitionCatalog } from "./authority";
import type { FactoryDefinitionDiagnostic } from "./compiler";
import { catalogForStoredFactoryDefinition } from "./settings-persistence";
import {
  selectDefaultFactory,
  selectStoredFactoryDefinition,
  type FactoryDefinitionTarget,
} from "./storage";
import {
  readCompiledFactoryDefinition,
  recompileStoredFactoryDefinition,
} from "./stored-definition";

type CheckScope = {
  admin: SupabaseClient<Database>;
  workspaceId: string;
  target: FactoryDefinitionTarget;
};
type CheckFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 500;
  error: string;
  diagnostics?: FactoryDefinitionDiagnostic[];
};

export async function readFactoryDefinitionCapabilityCheck(
  scope: CheckScope,
): Promise<CheckFailure | { ok: true; check: SandboxCapabilityCheckState | null }> {
  try {
    const target = await loadStoredDefinition(scope);
    if (!target) return unavailableDefinition();
    const { stored } = target;
    const bundle = readCompiledFactoryDefinition(stored.definition_json);
    if (!bundle) return invalidDefinition();
    return {
      ok: true,
      check: await getLatestSandboxCapabilityCheck({
        admin: scope.admin,
        workspaceId: scope.workspaceId,
        repositoryId: bundle.repositoryId,
        definitionDigest: stored.canonical_digest,
      }),
    };
  } catch (error) {
    return checkFailure(error);
  }
}

export async function startFactoryDefinitionCapabilityCheck(
  scope: CheckScope & { actorUserId: string },
): Promise<
  CheckFailure | { ok: true; check: SandboxCapabilityCheckState; complete: () => Promise<unknown> }
> {
  const { admin, workspaceId, actorUserId } = scope;
  try {
    const target = await loadStoredDefinition(scope);
    if (!target) return unavailableDefinition();
    const { stored } = target;
    const catalog = await loadFactoryDefinitionCatalog(admin, {
      workspaceId,
      factoryId: target.factoryId,
      agentPromptRevisionId: readCompiledFactoryDefinition(stored.definition_json)
        ?.implementationAgent?.promptRevisionId,
    });
    const compiled = recompileStoredFactoryDefinition(
      stored.definition_json,
      stored.canonical_digest,
      catalogForStoredFactoryDefinition(catalog, stored),
    );
    if (!compiled.ok) return invalidDefinition(compiled.diagnostics);
    const { agent, repositoryId, sandboxProvider } = compiled.bundle;
    const candidate = {
      agent: { provider: agent.provider, model: agent.model },
      definitionDigest: compiled.canonicalDigest,
      sandboxProvider,
    };
    const { check, repository } = await startSandboxCapabilityCheck({
      admin,
      workspaceId,
      repositoryId,
      candidate: { ...candidate, actorUserId },
    });
    return {
      ok: true,
      check,
      complete: () =>
        completeSandboxCapabilityCheck({
          admin,
          workspaceId,
          userId: actorUserId,
          checkId: check.id,
          repository,
          candidate: { ...candidate, connectionRevision: check.sandboxConnectionRevision ?? null },
        }),
    };
  } catch (error) {
    return checkFailure(error);
  }
}

async function loadStoredDefinition({ admin, workspaceId, target }: CheckScope) {
  const { data: factory, error: factoryError } = await selectDefaultFactory(admin, workspaceId);
  if (factoryError) throw factoryError;
  if (!factory) return null;
  const { data, error } = await selectStoredFactoryDefinition(
    admin,
    workspaceId,
    factory.id,
    target,
  );
  if (error) throw error;
  return data ? { stored: data, factoryId: factory.id } : null;
}

function invalidDefinition(diagnostics?: FactoryDefinitionDiagnostic[]): CheckFailure {
  return {
    ok: false,
    status: 422,
    error: "Review the saved definition before checking its runtime.",
    diagnostics,
  };
}

function unavailableDefinition(): CheckFailure {
  return {
    ok: false,
    status: 404,
    error: "The requested factory definition record is unavailable.",
  };
}

function checkFailure(error: unknown): CheckFailure {
  const code = typeof error === "object" && error && "code" in error ? error.code : null;
  switch (code) {
    case "42501":
      return { ok: false, status: 403, error: "Active workspace manager access is required." };
    case "P0002":
      return unavailableDefinition();
    case "PT409":
    case "P0010":
      return {
        ok: false,
        status: 409,
        error: "Workspace or sandbox access is changing. Retry the check shortly.",
      };
    case "PT422":
      return {
        ok: false,
        status: 422,
        error: "Connect the selected repository and sandbox before checking this definition.",
      };
    default:
      return {
        ok: false,
        status: 500,
        error: "Could not load or run the factory capability check.",
      };
  }
}
