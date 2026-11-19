import "server-only";

import { setTimeout as delay } from "node:timers/promises";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadFactorySkillBundle } from "@/lib/factory-skills/runtime";
import {
  loadRequiredWorkspaceSandboxConnection,
  SandboxConnectionInvalidError,
  SandboxConnectionMissingError,
} from "@/lib/sandbox-connections/server";
import type { Database, Tables } from "@/lib/supabase/database.types";

import { factoryActivationRequirements, loadFactoryDefinitionCatalog } from "./authority";
import {
  candidateSmokeEligibilitySchema,
  candidateSmokeTestSchema,
  type CandidateSmokeEligibility,
  type CandidateSmokeStart,
  type CandidateSmokeTest,
} from "./candidate-smoke-contracts";
import {
  acquireCandidateSmokeUtility,
  runCandidateSmokeExecution,
} from "./candidate-smoke-execution";
import { factoryComponentRevisionsForBundle, type CompiledFactoryDefinition } from "./compiler";
import {
  invalidDefinition,
  mutationError,
  type FactoryDefinitionMutationFailure,
} from "./mutations";
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

type Client = SupabaseClient<Database>;
type Failure = FactoryDefinitionMutationFailure;
type SmokeTestRow = Tables<"factory_definition_smoke_tests">;
type Scope = { workspaceId: string; admin: Client };
type FinalResult = {
  status: Exclude<CandidateSmokeTest["status"], "running">;
  evidence: NonNullable<CandidateSmokeTest["evidence"]>;
  errorText?: string;
};

const testSummaryColumns =
  "id,target_kind,target_id,definition_digest,base_activation_number,policy_version,status,created_at,lease_expires_at,finished_at,error_text";

const expiredMessage = "The smoke test expired before it recorded a result. Run it again.";

function summarizeSmokeTest(
  row: Pick<
    SmokeTestRow,
    | "id"
    | "target_kind"
    | "target_id"
    | "definition_digest"
    | "base_activation_number"
    | "policy_version"
    | "status"
    | "created_at"
    | "lease_expires_at"
    | "finished_at"
    | "error_text"
  > &
    Partial<Pick<SmokeTestRow, "evidence">>,
): CandidateSmokeTest {
  const expired = row.status === "running" && Date.parse(row.lease_expires_at) <= Date.now();
  return candidateSmokeTestSchema.parse({
    id: row.id,
    target: { kind: row.target_kind, id: row.target_id },
    definitionDigest: row.definition_digest,
    baseActivationNumber: row.base_activation_number,
    policyVersion: row.policy_version,
    status: expired ? "failed" : row.status,
    createdAt: row.created_at,
    finishedAt: expired ? row.lease_expires_at : row.finished_at,
    evidence: row.finished_at ? (row.evidence ?? null) : null,
    error: expired ? expiredMessage : row.error_text,
  });
}

type SmokeTestSelection = {
  client: Client;
  workspaceId: string;
  target: FactoryDefinitionTarget;
  digest: string;
};

export async function listFactoryDefinitionSmokeTests({
  client,
  workspaceId,
  target,
  digest,
}: SmokeTestSelection): Promise<Failure | { ok: true; tests: CandidateSmokeTest[] }> {
  const { data, error } = await client
    .from("factory_definition_smoke_tests")
    .select(testSummaryColumns)
    .eq("workspace_id", workspaceId)
    .eq("target_kind", target.kind)
    .eq("target_id", target.id)
    .eq("definition_digest", digest)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(20);
  if (error) return smokeTestError(error);
  return { ok: true, tests: data.map(summarizeSmokeTest) };
}

export async function readFactoryDefinitionSmokeTest({
  client,
  workspaceId,
  target,
  digest,
  testId,
}: SmokeTestSelection & { testId: string }): Promise<
  Failure | { ok: true; test: CandidateSmokeTest }
> {
  const { data, error } = await client
    .from("factory_definition_smoke_tests")
    .select(`${testSummaryColumns},evidence`)
    .eq("workspace_id", workspaceId)
    .eq("id", testId)
    .eq("target_kind", target.kind)
    .eq("target_id", target.id)
    .eq("definition_digest", digest)
    .maybeSingle();
  if (error) return smokeTestError(error);
  if (!data) return { ok: false, status: 404, error: "The candidate smoke test is unavailable." };
  return { ok: true, test: summarizeSmokeTest(data) };
}

export async function readFactoryDefinitionSmokeEligibility({
  admin,
  workspaceId,
  actorUserId,
  target,
  digest,
}: Scope & {
  actorUserId: string;
  target: FactoryDefinitionTarget;
  digest: string;
}): Promise<Failure | { ok: true; eligibility: CandidateSmokeEligibility }> {
  const { data: factory, error: factoryError } = await selectDefaultFactory(admin, workspaceId);
  if (factoryError || !factory) return smokeTestError(factoryError ?? { code: "P0002" });

  const { data: stored, error: storedError } = await selectStoredFactoryDefinition(
    admin,
    workspaceId,
    factory.id,
    target,
  );
  if (storedError || !stored) return smokeTestError(storedError ?? { code: "P0002" });
  if (stored.canonical_digest !== digest) {
    return smokeTestError({
      code: "PT409",
      message: "The factory candidate digest changed. Reload the definition.",
    });
  }

  // SQL checks the published or reserved identities against the current authorities.
  // Reading an immutable bundle avoids loading the entire catalog on each status refresh.
  const bundle = readCompiledFactoryDefinition(stored.definition_json);
  if (!bundle) {
    return smokeTestError({
      code: "PT422",
      message: "This candidate is incompatible with the current factory definition format.",
    });
  }
  const { enabledSandboxProviders, requiredProbes } = factoryActivationRequirements(bundle);
  const { data, error } = await admin.rpc("read_factory_candidate_activation_eligibility", {
    p_workspace_id: workspaceId,
    p_factory_id: factory.id,
    p_actor_user_id: actorUserId,
    p_target_kind: target.kind,
    p_target_id: target.id,
    p_definition_digest: digest,
    p_enabled_sandbox_providers: enabledSandboxProviders,
    p_required_probes: requiredProbes,
  });
  if (error) return smokeTestError(error);
  const eligibility = candidateSmokeEligibilitySchema.safeParse(data);
  return eligibility.success ? { ok: true, eligibility: eligibility.data } : smokeTestError(null);
}

export async function startFactoryDefinitionSmokeTest({
  admin,
  workspaceId,
  actorUserId,
  command,
}: Scope & {
  actorUserId: string;
  command: CandidateSmokeStart;
}): Promise<Failure | { ok: true; test: CandidateSmokeTest; run: (() => Promise<void>) | null }> {
  const { data: factory, error: factoryError } = await selectDefaultFactory(admin, workspaceId);
  if (factoryError) return smokeTestError(factoryError);
  if (!factory) return smokeTestError({ code: "P0002" });

  const { data: stored, error: storedError } = await selectStoredFactoryDefinition(
    admin,
    workspaceId,
    factory.id,
    command.target,
  );
  if (storedError) return smokeTestError(storedError);
  if (!stored) return smokeTestError({ code: "P0002" });
  if (stored.canonical_digest !== command.expectedDigest) {
    return smokeTestError({
      code: "PT409",
      message: "The saved definition has a different digest. Reload before testing.",
    });
  }

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
  const { data: reserved, error } = await admin.rpc("start_factory_definition_smoke_test", {
    p_workspace_id: workspaceId,
    p_factory_id: factory.id,
    p_actor_user_id: actorUserId,
    p_expected_activation_number: command.expectedActivationNumber,
    p_target_kind: command.target.kind,
    p_target_id: command.target.id,
    p_definition_digest: compiled.canonicalDigest,
    p_enabled_sandbox_providers: enabledSandboxProviders,
    p_required_probes: requiredProbes,
  });
  if (error || !reserved) return smokeTestError(error);

  const test = summarizeSmokeTest(reserved);
  const run =
    test.status === "running"
      ? () => completeCandidateSmoke({ admin, workspaceId, reserved, bundle: compiled.bundle })
      : null;
  return { ok: true, test, run };
}

export async function cancelFactoryDefinitionSmokeTest({
  admin,
  workspaceId,
  actorUserId,
  testId,
  digest,
}: Scope & {
  actorUserId: string;
  testId: string;
  digest: string;
}): Promise<Failure | { ok: true; test: CandidateSmokeTest }> {
  const { data: canceled, error } = await admin.rpc("cancel_factory_definition_smoke_test", {
    p_workspace_id: workspaceId,
    p_test_id: testId,
    p_actor_user_id: actorUserId,
    p_definition_digest: digest,
  });
  if (error || !canceled) return smokeTestError(error);
  return { ok: true, test: summarizeSmokeTest(canceled) };
}

function smokeTestError(error: { code: string; message?: string } | null): Failure {
  const mapped = mutationError(error);
  if (mapped.status === 500) {
    return { ok: false, status: 500, error: "Could not process the candidate smoke test." };
  }
  return mapped;
}

async function smokeTestIsRunning(
  { admin, workspaceId }: Scope,
  testId: string,
  signal: AbortSignal,
) {
  const { data, error } = await admin
    .from("factory_definition_smoke_tests")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", testId)
    .eq("status", "running")
    .gt("lease_expires_at", new Date().toISOString())
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw new Error("Could not check the candidate smoke test lease.");
  return data !== null;
}

async function monitorSmokeTest(
  scope: Scope,
  testId: string,
  lifecycle: AbortController,
  done: AbortSignal,
) {
  const signal = AbortSignal.any([lifecycle.signal, done]);
  try {
    while (!signal.aborted) {
      await delay(1_000, undefined, { signal });
      if (!(await smokeTestIsRunning(scope, testId, signal))) {
        lifecycle.abort("inactive");
      }
    }
  } catch {
    if (!signal.aborted) lifecycle.abort("unavailable");
  }
}

async function completeCandidateSmoke({
  admin,
  workspaceId,
  bundle,
  reserved,
}: Scope & {
  bundle: CompiledFactoryDefinition;
  reserved: SmokeTestRow;
}) {
  const scope = { admin, workspaceId };
  const profile = bundle.sandboxProvider;
  const done = new AbortController();
  const lifecycle = new AbortController();
  const leaseDeadline = AbortSignal.timeout(
    Math.max(0, Date.parse(reserved.lease_expires_at) - Date.now()),
  );
  const signal = AbortSignal.any([lifecycle.signal, leaseDeadline]);
  let monitor: Promise<void> | undefined;
  let blocked = false;
  let final: FinalResult = {
    status: "failed",
    evidence: { runtimeProfile: profile, stages: [] },
    errorText: "Could not complete the candidate smoke test. Run it again.",
  };
  try {
    if (!(await smokeTestIsRunning(scope, reserved.id, signal))) return;
    monitor = monitorSmokeTest(scope, reserved.id, lifecycle, done.signal);
    const skillInstructions = await loadFactorySkillBundle(admin, {
      workspaceId,
      factoryId: reserved.factory_id,
      skillRevisionIds: bundle.skillIds,
      signal,
    });
    const outcome = await runCandidateSmokeExecution({
      bundle,
      profile,
      signal,
      skillInstructions,
      acquire: async (acquireSignal) => {
        let connection;
        try {
          ({ connection } = await loadRequiredWorkspaceSandboxConnection(
            admin,
            workspaceId,
            profile,
          ));
        } catch (error) {
          blocked =
            error instanceof SandboxConnectionMissingError ||
            error instanceof SandboxConnectionInvalidError;
          throw error;
        }
        if (
          connection.provider !== profile ||
          connection.revision !== reserved.sandbox_connection_revision
        ) {
          blocked = true;
          throw new Error("The sandbox connection changed after this test was reserved.");
        }
        if (!(await smokeTestIsRunning(scope, reserved.id, acquireSignal))) {
          lifecycle.abort("inactive");
          acquireSignal.throwIfAborted();
          throw new Error("The candidate smoke test is no longer running.");
        }
        return acquireCandidateSmokeUtility({
          admin,
          workspaceId,
          requestId: reserved.id,
          connection,
          signal: acquireSignal,
        });
      },
    });
    if (blocked) {
      final = {
        status: "blocked",
        evidence: outcome.evidence,
        errorText: "The saved definition’s sandbox connection changed. Run a new test.",
      };
    } else if (lifecycle.signal.reason !== "unavailable" && !leaseDeadline.aborted) {
      final = outcome;
    }
  } catch {
    // A bounded failure is recorded without persisting raw provider errors.
  } finally {
    done.abort();
    await monitor;
  }

  const { error } = await admin.rpc("finish_factory_definition_smoke_test", {
    p_workspace_id: workspaceId,
    p_test_id: reserved.id,
    p_status: final.status,
    p_evidence: final.evidence,
    ...(final.errorText ? { p_error_text: final.errorText } : {}),
  });
  if (error) throw new Error("Could not finalize the candidate smoke test.");
}
