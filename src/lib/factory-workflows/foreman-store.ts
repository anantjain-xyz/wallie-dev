import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { workflowNodeIdSchema } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import type { WorkflowOccurrencePin } from "./deterministic-command";
import { parseForemanPlan } from "./foreman-command";
import { createOpenAiForemanProvider, openAiForemanIssuanceSchema } from "./foreman-openai";
import {
  runFactoryWorkflowForeman,
  type ForemanInferencePermit,
  type ForemanInferenceProvider,
  type ForemanRunSnapshot,
  type ForemanRunStore,
} from "./foreman-runtime";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const generation = z.number().int().positive().safe();
const ordinal = z.union([z.literal(1), z.literal(2)]);
const kind = z.enum(["route", "delegate", "read_child"]);
const tokens = z.number().int().nonnegative().safe();
const usage = z
  .object({
    inputTokens: tokens.nullable(),
    outputTokens: tokens.nullable(),
    costUsd: z.number().min(0).max(1_000_000_000).nullable(),
  })
  .strict();

const acceptedRouteReceipt = z.object({
  ordinal,
  kind: z.literal("route"),
  status: z.literal("accepted"),
  decisionId: uuid,
});
const receiptSchema = z.union([
  acceptedRouteReceipt
    .extend({
      resolution: z.enum(["selected", "fallback"]),
      transitionId: uuid,
      targetOccurrenceId: uuid,
    })
    .strict(),
  acceptedRouteReceipt
    .extend({
      resolution: z.literal("clarification"),
      transitionId: z.null(),
      targetOccurrenceId: z.null(),
    })
    .strict(),
  z
    .object({
      ordinal,
      kind: z.literal("delegate"),
      status: z.literal("accepted"),
      decisionId: uuid,
      targetOccurrenceId: uuid,
      childSessionId: uuid,
      jobId: uuid,
      runId: uuid,
    })
    .strict(),
  z
    .object({
      ordinal,
      kind: z.literal("read_child"),
      status: z.literal("accepted"),
      childSessionId: uuid,
      targetOccurrenceId: uuid,
      phaseStatus: z.string().regex(/^[a-z_]{1,64}$/),
    })
    .strict(),
  z
    .object({
      ordinal,
      kind,
      status: z.literal("blocked"),
      code: z.enum([
        "no_authorized_target",
        "checkpoint_required",
        "child_unavailable",
        "budget_exhausted",
      ]),
    })
    .strict(),
]);
const dispatchSchema = z.union([
  receiptSchema,
  z.object({ status: z.literal("waiting"), code: z.literal("route_budget_unavailable") }).strict(),
]);
const commandRecordSchema = z
  .object({ ordinal, command: z.record(z.unknown()), receipt: receiptSchema.optional() })
  .strict();

const runBase = z.object({
  foremanRunId: uuid,
  rootSessionId: uuid,
  workspaceId: uuid,
  factoryId: uuid,
  routeOccurrenceId: uuid,
  routeNodeId: workflowNodeIdSchema,
  workflowDigest: digest,
  issuedGeneration: generation,
  currentGeneration: generation,
  parentSessionId: uuid,
  sourceCheckpointRunId: uuid.nullable(),
  issuedAt: timestamp,
  deadlineAt: timestamp,
  usage,
  providerReceiptId: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,160}$/)
    .optional(),
});
const blockedInference = z.enum([
  "invalid_plan",
  "invalid_permit",
  "provider_unavailable",
  "timeout",
  "budget_exhausted",
]);
const runSchema = z.discriminatedUnion("status", [
  runBase
    .extend({
      status: z.literal("issued"),
      commands: z.tuple([]),
    })
    .strict(),
  runBase
    .extend({
      status: z.literal("accepted"),
      settledAt: timestamp,
      planJson: z
        .string()
        .min(1)
        .max(24 * 1024),
      planDigest: digest,
      commands: z.array(commandRecordSchema).min(1).max(2),
    })
    .strict(),
  runBase
    .extend({
      status: z.literal("blocked"),
      settledAt: timestamp,
      code: blockedInference,
      commands: z.tuple([]),
    })
    .strict(),
  runBase
    .extend({
      status: z.literal("stale"),
      settledAt: timestamp,
      code: z.enum(["inference_deadline_elapsed", "ownership_lost"]),
      commands: z.tuple([]),
    })
    .strict(),
]);
const beginSchema = z.discriminatedUnion("status", [
  openAiForemanIssuanceSchema,
  z.object({ status: z.literal("existing"), run: runSchema }).strict(),
  z
    .object({
      status: z.literal("blocked"),
      code: z.enum([
        "profile_unavailable",
        "route_unavailable",
        "route_already_decided",
        "root_unavailable",
        "parent_unavailable",
        "execution_policy_required",
        "budget_exhausted",
      ]),
    })
    .strict(),
]);

type Projection = z.output<typeof runSchema>;
type Issue = z.output<typeof openAiForemanIssuanceSchema>;
type BeginBlocked = z.output<typeof beginSchema> & { status: "blocked" };
type FreshIssueBlocker =
  | BeginBlocked["code"]
  | "execution_budget_exhausted"
  | "workflow_visit_limit_exhausted";
type Admin = SupabaseClient<Database>;

function readArgs(pin: WorkflowOccurrencePin) {
  return {
    p_root_session_id: pin.p_root_session_id,
    p_workspace_id: pin.p_workspace_id,
    p_factory_id: pin.p_factory_id,
    p_route_occurrence_id: pin.occurrenceId,
  };
}

function ownerArgs(pin: WorkflowOccurrencePin) {
  return {
    ...readArgs(pin),
    p_expected_generation: pin.p_expected_generation,
    p_ownership_token: pin.p_ownership_token,
  };
}

function matchesPin(row: Projection | Issue, pin: WorkflowOccurrencePin) {
  return (
    row.rootSessionId === pin.p_root_session_id &&
    row.workspaceId === pin.p_workspace_id &&
    row.factoryId === pin.p_factory_id &&
    row.routeOccurrenceId === pin.occurrenceId &&
    row.routeNodeId === pin.nodeId &&
    row.workflowDigest === pin.workflowDigest
  );
}

function parseProjection(data: unknown, pin: WorkflowOccurrencePin) {
  const parsed = runSchema.safeParse(data);
  if (
    !parsed.success ||
    !matchesPin(parsed.data, pin) ||
    parsed.data.currentGeneration < parsed.data.issuedGeneration
  )
    throw new Error("Invalid factory foreman run projection.");
  return parsed.data;
}

function toSnapshot(run: Projection): ForemanRunSnapshot {
  const identity = {
    foremanRunId: run.foremanRunId,
    rootSessionId: run.rootSessionId,
    workspaceId: run.workspaceId,
    factoryId: run.factoryId,
    routeOccurrenceId: run.routeOccurrenceId,
    nodeId: run.routeNodeId,
    workflowDigest: run.workflowDigest,
    generation: run.currentGeneration,
  };
  if (run.status === "issued") return { identity, phase: "issued", deadlineAt: run.deadlineAt };
  if (run.status === "blocked") return { identity, phase: "blocked", code: run.code };
  if (run.status === "stale")
    return {
      identity,
      phase: "blocked",
      code: run.code === "inference_deadline_elapsed" ? "timeout" : "invalid_permit",
    };

  const frozenPlan = parseForemanPlan(run.planJson);
  const commandPlan = parseForemanPlan(
    JSON.stringify({ version: 1, commands: run.commands.map((entry) => entry.command) }),
  );
  if (
    frozenPlan.status !== "parsed" ||
    commandPlan.status !== "parsed" ||
    JSON.stringify(frozenPlan.plan) !== JSON.stringify(commandPlan.plan) ||
    run.commands.some(
      (entry, index) =>
        entry.ordinal !== index + 1 ||
        (entry.receipt &&
          (entry.receipt.ordinal !== entry.ordinal ||
            entry.receipt.kind !== frozenPlan.plan.commands[index].kind ||
            (index > 0 && !run.commands[index - 1].receipt))),
    )
  )
    throw new Error("Invalid factory foreman command projection.");

  return {
    identity,
    phase: "accepted",
    planJson: run.planJson,
    planDigest: run.planDigest,
    receipts: run.commands.flatMap(({ receipt }) =>
      receipt ? [{ ...receipt, foremanRunId: run.foremanRunId }] : [],
    ),
  };
}

function toPermit(issue: Issue): ForemanInferencePermit {
  return {
    identity: {
      foremanRunId: issue.foremanRunId,
      rootSessionId: issue.rootSessionId,
      workspaceId: issue.workspaceId,
      factoryId: issue.factoryId,
      routeOccurrenceId: issue.routeOccurrenceId,
      nodeId: issue.routeNodeId,
      workflowDigest: issue.workflowDigest,
      generation: issue.executionGeneration,
    },
    issueId: issue.issueId,
    profile: {
      modelId: issue.model,
      providerRoute: "openai",
      encryptedCredential: issue.encryptedCredential,
    },
    prompt: {
      revisionId: issue.promptRevisionId,
      text: issue.promptMd,
      sha256: issue.promptSha256,
    },
    context: {
      title: issue.title,
      work: issue.taskPromptMd,
      destinationIds: issue.allowedDestinationIds,
      children: issue.offeredChildren.map(({ childRef, phaseStatus }) => ({
        ref: childRef,
        progress: phaseStatus,
      })),
    },
    budget: {
      maxInputBytes: issue.maxInputBytes,
      maxOutputTokens: issue.maxOutputTokens,
      maxTotalTokens: issue.reservedTokens,
      maxCostUsd: issue.reservedCostUsd,
      deadlineAt: issue.deadlineAt,
    },
  };
}

/** Execute the configured foreman occurrence through native receipts and return a safe progress view. */
export async function executeFactoryWorkflowForeman(
  admin: Admin,
  pin: WorkflowOccurrencePin,
  {
    freshIssueBlocker,
    signal,
    bindProvider = createOpenAiForemanProvider,
  }: {
    freshIssueBlocker?: FreshIssueBlocker;
    signal?: AbortSignal;
    bindProvider?: typeof createOpenAiForemanProvider;
  } = {},
) {
  const state: { projection: Projection | null; invoke?: ForemanInferenceProvider } = {
    projection: null,
  };
  const store: ForemanRunStore = {
    async readRun(owner) {
      const { data, error } = await admin.rpc("read_factory_workflow_foreman_run", readArgs(owner));
      if (error) throw new Error("The factory foreman run could not be read.");
      if (data === null) return null;
      const parsed = parseProjection(data, owner);
      const snapshot = toSnapshot(parsed);
      state.projection = parsed;
      return snapshot;
    },
    async beginInference(owner) {
      if (freshIssueBlocker) return { status: "blocked", code: freshIssueBlocker };
      const { data, error } = await admin.rpc(
        "begin_factory_workflow_foreman_inference",
        ownerArgs(owner),
      );
      const parsed = beginSchema.safeParse(data);
      if (error || !parsed.success) throw new Error("The factory foreman issuance is unavailable.");
      const issued = parsed.data;
      if (issued.status === "blocked") return issued;
      if (issued.status === "existing") {
        parseProjection(issued.run, owner);
        return { status: "existing" };
      }
      if (!matchesPin(issued, owner) || issued.executionGeneration !== owner.p_expected_generation)
        throw new Error("The factory foreman issuance has a different scope.");
      state.invoke = bindProvider({ issued, pin: owner });
      return { status: "issued", permit: toPermit(issued) };
    },
    async settleInference(owner, runId, issueId, outcome, signal) {
      const settlement = admin.rpc("settle_factory_workflow_foreman_inference", {
        ...ownerArgs(owner),
        p_issue_id: issueId,
        p_outcome: outcome,
      });
      const { data, error } = await (signal ? settlement.abortSignal(signal) : settlement);
      if (error || data === null) throw new Error("The factory foreman settlement is unavailable.");
      const settled = parseProjection(data, owner);
      if (
        settled.foremanRunId !== runId ||
        settled.issuedGeneration !== owner.p_expected_generation
      )
        throw new Error("The factory foreman settlement has a different issue.");
    },
    async dispatchCommand(owner, runId, commandOrdinal) {
      const { data, error } = await admin.rpc("dispatch_factory_workflow_foreman_command", {
        ...ownerArgs(owner),
        p_foreman_run_id: runId,
        p_ordinal: commandOrdinal,
      });
      if (error) return { status: "unavailable" };
      const parsed = dispatchSchema.safeParse(data);
      if (!parsed.success) return { status: "unavailable" };
      if (parsed.data.status === "waiting") return { status: "waiting" };
      return {
        status: "recorded",
        receipt: { ...parsed.data, foremanRunId: runId },
      };
    },
  };
  const invoke: ForemanInferenceProvider = async (request) => {
    const bound = state.invoke;
    state.invoke = undefined;
    if (!bound)
      return {
        status: "blocked",
        code: "provider_unavailable",
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
      };
    return bound(request);
  };
  let progress: Awaited<ReturnType<typeof runFactoryWorkflowForeman>>;
  try {
    progress = await runFactoryWorkflowForeman({ store, invoke, pin, signal });
  } catch {
    progress = { status: "unavailable" };
  }
  const run = state.projection;
  return {
    ...progress,
    ...(run ? { foremanRunId: run.foremanRunId, usage: run.usage } : {}),
  };
}
