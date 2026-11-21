import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  trustedPromptValue,
  untrustedPromptValue,
  type PromptValue,
  type UntrustedPromptValue,
} from "@/lib/pipeline/prompt-safety";
import { renderStagePrompt } from "@/lib/prompt-templates";
import { createUtilitySandbox, stopSandboxById } from "@/lib/sandbox";
import { observeUntilAbort } from "@/lib/sandbox/lifecycle";
import type { SandboxConnection, SandboxHandle, SandboxImplementation } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";
import {
  recordWorkspaceSandbox,
  reserveWorkspaceSandbox,
  settleWorkspaceResource,
  WorkspaceDeletingError,
} from "@/lib/workspaces/resource-operations";

import type { CompiledFactoryDefinition } from "./compiler";

export const CANDIDATE_SMOKE_EXECUTION_TIMEOUT_MS = 90_000;

const utilityLifetimeMs = 120_000;
const cleanupDeadlineMs = 20_000;
const retainedStageLimit = 32;
const unsupportedNodeExit = 42;
const nodeCheck = `if (Number(process.versions.node.split(".")[0]) < 22) process.exit(${unsupportedNodeExit});`;

// Only this application-authored script runs in the bare sandbox. Each command
// consumes the synthetic predecessor's file state before advancing the fixture.
const serialStageFixture = `
const { readFileSync, writeFileSync } = require("node:fs");
const [statePath, ordinalText] = process.argv.slice(1);
const ordinal = Number(ordinalText);
if (!Number.isSafeInteger(ordinal) || ordinal < 1) process.exit(1);
if (ordinal === 1) {
  writeFileSync(statePath, "1", { flag: "wx", mode: 0o600 });
} else {
  if (readFileSync(statePath, "utf8") !== String(ordinal - 1)) process.exit(1);
  writeFileSync(statePath, ordinalText);
}
`;

export type CandidateSmokeUtility = {
  sandbox: Pick<SandboxHandle, "exec">;
  cwd: string;
  close: () => Promise<void>;
};

type StageEvidence = { stageId: string; promptDigest: string };

type FixtureFailure =
  | { status: "blocked"; reason: "invalid_prompt" | "profile_mismatch" }
  | {
      status: "failed";
      reason: "sandbox_unavailable" | "fixture_failed" | "timeout" | "cleanup_failed";
    }
  | { status: "unsupported"; reason: "node_unavailable" }
  | { status: "canceled"; reason: "canceled" };

type FixtureOutcome = { status: "passed" } | FixtureFailure;

export type CandidateSmokeExecutionResult = {
  status: FixtureOutcome["status"];
  evidence: {
    runtimeProfile: SandboxImplementation;
    stageCount: number;
    completedStageCount: number;
    stages: StageEvidence[];
    reason?: FixtureFailure["reason"];
    cleanupPending?: true;
  };
};

async function renderPrompts(
  bundle: CompiledFactoryDefinition,
  skillInstructions: readonly PromptValue[],
  signal: AbortSignal,
) {
  const stageSlugs = new Set<string>();
  const previousArtifacts = new Map<string, [slug: string, value: UntrustedPromptValue]>();
  const evidence: StageEvidence[] = [];

  for (const [index, stage] of bundle.stages.entries()) {
    if (index > 0 && index % retainedStageLimit === 0) await setImmediate();
    signal.throwIfAborted();
    if (
      previousArtifacts.has(stage.id) ||
      stageSlugs.has(stage.slug) ||
      stage.previousStageIds.some((id) => !previousArtifacts.has(id))
    )
      throw new Error("Invalid serial prompt references.");

    const referencedArtifacts = new Set([
      ...bundle.operatingRuleStageIds,
      ...stage.previousStageIds,
    ]);
    const predecessorValues: Record<string, UntrustedPromptValue> = Object.fromEntries(
      [...referencedArtifacts].flatMap((id) => {
        const artifact = previousArtifacts.get(id);
        return artifact ? [artifact] : [];
      }),
    );
    const prompt = renderStagePrompt(
      {
        promptTemplateMd: trustedPromptValue("stage.promptTemplate", stage.promptTemplateMd),
        slug: trustedPromptValue("stage.slug", stage.slug),
      },
      {
        skillInstructions,
        ...(bundle.implementationAgent
          ? {
              agentPromptMd: trustedPromptValue(
                "agent.prompt",
                bundle.implementationAgent.promptMd,
              ),
            }
          : {}),
        attemptFeedback: null,
        attemptNumber: 1,
        operatingRulesMd: trustedPromptValue("pipeline.operatingRules", bundle.operatingRulesMd),
        previousStages: predecessorValues,
        repoName: untrustedPromptValue("repo.name", "fixture"),
        repoFullName: untrustedPromptValue("repo.fullName", "wallie-smoke/fixture"),
        repoDefaultBranch: untrustedPromptValue("repo.defaultBranch", "main"),
        sessionPrompt: untrustedPromptValue("session.prompt", "Check the synthetic stage handoff."),
        sessionTitle: untrustedPromptValue("session.title", "Factory configuration smoke test"),
      },
    );
    if (evidence.length < retainedStageLimit) {
      evidence.push({
        stageId: stage.id,
        promptDigest: createHash("sha256").update(prompt, "utf8").digest("hex"),
      });
    }
    stageSlugs.add(stage.slug);
    previousArtifacts.set(stage.id, [
      stage.slug,
      untrustedPromptValue(
        `artifact.previousStages.${stage.slug}`,
        "Synthetic approved artifact from a completed stage.",
      ),
    ]);
  }

  return evidence;
}

async function executeFixedCommand(
  utility: CandidateSmokeUtility,
  args: string[],
  signal: AbortSignal,
) {
  return observeUntilAbort(signal, async () => {
    const command = await utility.sandbox.exec("node", args, { cwd: utility.cwd, signal });
    return command.exitCode;
  });
}

/** Runs only the synthetic serial handoff. Candidate text remains on the server. */
export async function runCandidateSmokeExecution(input: {
  bundle: CompiledFactoryDefinition;
  skillInstructions?: readonly PromptValue[];
  profile: SandboxImplementation;
  acquire: (signal: AbortSignal) => Promise<CandidateSmokeUtility>;
  signal?: AbortSignal;
}): Promise<CandidateSmokeExecutionResult> {
  const deadline = AbortSignal.timeout(CANDIDATE_SMOKE_EXECUTION_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  let stages: StageEvidence[] = [];
  let completedStageCount = 0;
  let utility: CandidateSmokeUtility | undefined;
  let cleanupPending = false;

  function interrupted(fallback: FixtureFailure): FixtureFailure {
    if (input.signal?.aborted) return { status: "canceled", reason: "canceled" };
    if (deadline.aborted) return { status: "failed", reason: "timeout" };
    return fallback;
  }

  async function execute(): Promise<FixtureOutcome> {
    if (signal.aborted) return interrupted({ status: "blocked", reason: "invalid_prompt" });
    if (input.profile !== "fake" && input.profile !== input.bundle.sandboxProvider) {
      return { status: "blocked", reason: "profile_mismatch" };
    }

    try {
      if (!input.bundle.stages.length) throw new Error("No serial stage.");
      stages = await renderPrompts(input.bundle, input.skillInstructions ?? [], signal);
    } catch {
      return interrupted({ status: "blocked", reason: "invalid_prompt" });
    }

    try {
      const acquisition = input.acquire(signal);
      try {
        utility = await observeUntilAbort(signal, () => acquisition);
      } catch (error) {
        // A driver that resolves after cancellation still owns a resource.
        if (signal.aborted) void acquisition.then((late) => late.close()).catch(() => undefined);
        throw error;
      }
    } catch {
      return interrupted({ status: "failed", reason: "sandbox_unavailable" });
    }

    try {
      const nodeAvailable = await executeFixedCommand(utility, ["-e", nodeCheck], signal);
      if ([unsupportedNodeExit, 126, 127].includes(nodeAvailable)) {
        return { status: "unsupported", reason: "node_unavailable" };
      }
      if (nodeAvailable !== 0) return { status: "failed", reason: "fixture_failed" };

      const statePath = `.wallie-smoke-${randomUUID()}`;
      for (const [index] of input.bundle.stages.entries()) {
        const code = await executeFixedCommand(
          utility,
          ["-e", serialStageFixture, "--", statePath, String(index + 1)],
          signal,
        );
        if (code !== 0) return { status: "failed", reason: "fixture_failed" };
        completedStageCount += 1;
      }
      signal.throwIfAborted();
      return { status: "passed" };
    } catch {
      return interrupted({ status: "failed", reason: "fixture_failed" });
    }
  }

  let outcome: FixtureOutcome;
  try {
    outcome = await execute();
  } finally {
    if (utility) {
      try {
        await observeUntilAbort(AbortSignal.timeout(cleanupDeadlineMs), utility.close);
      } catch {
        cleanupPending = true;
      }
    }
  }

  if (input.signal?.aborted) outcome = { status: "canceled", reason: "canceled" };
  if (cleanupPending && outcome.status === "passed") {
    outcome = { status: "failed", reason: "cleanup_failed" };
  }
  return {
    status: outcome.status,
    evidence: {
      runtimeProfile: input.profile,
      stageCount: input.bundle.stages.length,
      completedStageCount,
      stages,
      ...(outcome.status === "passed" ? {} : { reason: outcome.reason }),
      ...(cleanupPending ? { cleanupPending: true } : {}),
    },
  };
}

/** Acquire an empty utility sandbox under existing workspace resource ownership. */
export async function acquireCandidateSmokeUtility(input: {
  admin: SupabaseClient<Database>;
  workspaceId: string;
  requestId: string;
  connection: SandboxConnection;
  signal: AbortSignal;
}): Promise<CandidateSmokeUtility> {
  input.signal.throwIfAborted();
  const { admin, connection, workspaceId } = input;
  const operationId = await reserveWorkspaceSandbox(admin, {
    connection,
    provider: connection.provider,
    timeoutMs: utilityLifetimeMs,
    acquisitionTimeoutMs: 60_000,
    workspaceId,
  });

  let recorded = false;
  try {
    const sandbox = await createUtilitySandbox(
      {
        workspaceId,
        ownerId: input.requestId,
        timeoutMs: utilityLifetimeMs,
        signal: input.signal,
        onSandboxCreated: async ({ sandboxId }) => {
          const accepted = await recordWorkspaceSandbox(admin, operationId, sandboxId);
          recorded = true;
          if (!accepted) throw new WorkspaceDeletingError();
        },
      },
      connection,
    );
    return {
      sandbox,
      cwd: "/tmp",
      close: async () => {
        try {
          await stopSandboxById(sandbox.id, { connection, throwOnError: true });
          await settleWorkspaceResource(admin, operationId, true);
        } catch (error) {
          await settleWorkspaceResource(admin, operationId, false).catch(() => undefined);
          throw error;
        } finally {
          await sandbox[Symbol.asyncDispose]?.().catch(() => undefined);
        }
      },
    };
  } catch (error) {
    if (recorded) {
      await settleWorkspaceResource(admin, operationId, false).catch(() => undefined);
    }
    // An acquisition without a returned ID remains recoverable until its provider TTL.
    throw error;
  }
}
