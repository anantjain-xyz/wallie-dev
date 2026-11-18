import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";
import {
  completeSandboxCapabilityCheck,
  getLatestSandboxCapabilityCheck,
  startSandboxCapabilityCheck,
  type FactoryCapabilityCandidate,
} from "@/lib/sandbox-capabilities/server";
import type { Database } from "@/lib/supabase/database.types";

import type { CompiledFactoryDefinition } from "./compiler";
import { factoryWritableRepositoryIds } from "./repository-bindings";
import {
  selectDefaultFactory,
  selectStoredFactoryDefinition,
  type FactoryDefinitionTarget,
} from "./storage";
import { readVerifiedFactoryDefinition } from "./stored-definition";

type CheckScope = {
  admin: SupabaseClient<Database>;
  workspaceId: string;
  target: FactoryDefinitionTarget;
  repositoryId?: string;
};
type CheckFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 500;
  error: string;
};

export async function readFactoryDefinitionCapabilityCheck(
  scope: CheckScope,
): Promise<CheckFailure | { ok: true; check: SandboxCapabilityCheckState | null }> {
  try {
    const stored = await loadStoredDefinition(scope);
    if (!stored) return unavailableDefinition();
    const bundle = readVerifiedFactoryDefinition(stored.definition_json, stored.canonical_digest);
    if (!bundle) return invalidDefinition();
    const repositoryId = selectCheckRepository(bundle, scope.repositoryId);
    if (!repositoryId) return unavailableRepository();
    return {
      ok: true,
      check: await getLatestSandboxCapabilityCheck({
        admin: scope.admin,
        workspaceId: scope.workspaceId,
        repositoryId,
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
    const stored = await loadStoredDefinition(scope);
    if (!stored) return unavailableDefinition();
    const bundle = readVerifiedFactoryDefinition(stored.definition_json, stored.canonical_digest);
    if (!bundle) return invalidDefinition();
    // The reservation checks current access to the selected writer and sandbox.
    // A probe of that runtime does not need the other resources used by execution.
    const { agent, sandboxProvider } = bundle;
    const repositoryId = selectCheckRepository(bundle, scope.repositoryId);
    if (!repositoryId) return unavailableRepository();
    const candidate: FactoryCapabilityCandidate = {
      agent: { provider: agent.provider, model: agent.model },
      definitionDigest: stored.canonical_digest,
      executionIdentity: bundle.executionGrant ? "service-principal" : "human",
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

function selectCheckRepository(bundle: CompiledFactoryDefinition, requestedId?: string) {
  const id = requestedId ?? bundle.repositoryId;
  return factoryWritableRepositoryIds(bundle).includes(id) ? id : null;
}

function unavailableRepository(): CheckFailure {
  return {
    ok: false,
    status: 422,
    error: "Choose a writable repository from this factory definition.",
  };
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
  return data;
}

function invalidDefinition(): CheckFailure {
  return {
    ok: false,
    status: 422,
    error: "Review the saved definition before checking its runtime.",
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
