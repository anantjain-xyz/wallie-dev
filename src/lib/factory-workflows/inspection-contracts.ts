import { z } from "zod";

const uuid = z.string().uuid();
const positiveInteger = z.number().int().safe().positive();

const workflowInspectionRootSchema = z.object({
  sessionId: uuid,
  sessionNumber: positiveInteger,
  workspaceId: uuid,
  factoryId: uuid,
  graphRevisionId: uuid,
  workflowDigest: z.string().regex(/^[a-f0-9]{64}$/),
  lifecycleStatus: z.enum(["running", "paused", "canceled"]),
  generation: positiveInteger,
  canManage: z.boolean(),
  workflowId: uuid.nullish(),
  activationId: uuid.nullish(),
});

export const workflowInspectionHeaderSchema = z.object({
  root: workflowInspectionRootSchema,
  subject: z.object({
    sessionId: uuid,
    sessionNumber: positiveInteger,
    runId: uuid.nullable(),
  }),
});

const workflowInspectionEventKind = z.enum([
  "occurrence",
  "transition",
  "route",
  "foreman",
  "branch",
  "child",
  "attempt",
  "join",
  "repository",
  "review",
  "repair",
  "artifact",
  "approval",
  "lifecycle",
]);

const label = z.string().nullish();
const identity = uuid.nullish();
const counter = z.number().int().safe().nonnegative();
const nullableCounter = counter.nullish();
const decimal = z.number().finite().nonnegative();
const boolean = z.boolean().nullish();
const recordedAt = z.string().datetime({ offset: true });
const receiptId = z.string().min(1).max(100);
const sourceLocation = {
  sessionId: identity,
  sessionNumber: positiveInteger.nullish(),
  runId: identity,
};
const repositoryLocation = {
  repositoryId: identity,
  repositoryName: label,
};
const artifactLocation = {
  artifactId: identity,
  artifactVersion: nullableCounter,
  stageSlug: label,
};

const workflowInspectionEventBase = z.object({
  id: receiptId,
  recordedAt,
  occurrenceId: identity,
  nodeId: label,
  state: z.string(),
});

function event<
  Kind extends z.infer<typeof workflowInspectionEventKind>,
  Detail extends z.ZodRawShape,
>(kind: Kind, detail: Detail) {
  return workflowInspectionEventBase.extend({ kind: z.literal(kind), detail: z.object(detail) });
}

const workflowInspectionEventSchema = z.discriminatedUnion("kind", [
  event("occurrence", {
    nodeKind: label,
    entry: boolean,
    generation: nullableCounter,
    resultId: identity,
  }),
  event("transition", {
    sourceOccurrenceId: identity,
    targetOccurrenceId: identity,
    sourceResultId: identity,
    edgeId: label,
    edgeKind: label,
    generation: nullableCounter,
  }),
  event("route", {
    resolution: label,
    selectedEdgeId: label,
    selectedDestinationId: label,
    targetOccurrenceId: identity,
    generation: nullableCounter,
  }),
  event("foreman", {
    parentSessionId: identity,
    sessionNumber: positiveInteger.nullish(),
    checkpointRunId: identity,
    blocker: label,
    generation: nullableCounter,
  }),
  event("branch", {
    groupId: identity,
    slotId: identity,
    joinNodeId: label,
    branchEdgeId: label,
    required: boolean,
    outcomeId: identity,
    admissionBlocker: label,
    parentSessionId: identity,
    childSessionId: identity,
    sessionNumber: positiveInteger.nullish(),
    runId: identity,
  }),
  event("child", {
    parentSessionId: identity,
    parentSessionNumber: positiveInteger.nullish(),
    childSessionId: identity,
    sessionNumber: positiveInteger.nullish(),
    jobId: identity,
    runId: identity,
    groupId: identity,
    slotId: identity,
    sourceDecisionId: identity,
    ...repositoryLocation,
  }),
  event("attempt", {
    ...sourceLocation,
    parentSessionId: identity,
    jobId: identity,
    attemptCount: nullableCounter,
    current: boolean,
    retired: boolean,
    source: label,
    groupId: identity,
    jobStatus: label,
  }),
  event("join", {
    ...sourceLocation,
    ...repositoryLocation,
    ...artifactLocation,
    joinId: identity,
    groupId: identity,
    parentSessionId: identity,
    inputRunId: identity,
    selectedOutcomeIds: z.array(uuid).nullish(),
    omittedBranchEdgeIds: z.array(z.string()).nullish(),
    deliveryStatus: label,
    wholeJoinComplete: boolean,
  }),
  event("repository", {
    ...sourceLocation,
    ...repositoryLocation,
    joinId: identity,
    parentSessionId: identity,
    validationRunId: identity,
    blocker: label,
    attempts: nullableCounter,
    acceptedHeadReceiptId: identity,
    remoteReconciliationRequired: boolean,
    commitSha: label,
    validationTreeSha: label,
  }),
  event("review", {
    ...sourceLocation,
    ...repositoryLocation,
    ...artifactLocation,
    reviewId: identity,
    reviewReceiptId: identity,
    joinId: identity,
    parentSessionId: identity,
    commitSha: label,
    validationTreeSha: label,
    verdict: label,
    blocker: label,
    nextReviewOccurrenceId: identity,
  }),
  event("repair", {
    ...sourceLocation,
    repairReceiptId: identity,
    reviewReceiptId: identity,
    priorRepairReceiptId: identity,
    jobId: identity,
    outputRunId: identity,
    nextReviewOccurrenceId: identity,
    parentSessionId: identity,
    joinId: identity,
  }),
  event("artifact", {
    ...sourceLocation,
    ...repositoryLocation,
    ...artifactLocation,
    stageId: identity,
    commitSha: label,
    approvalState: label,
  }),
  event("approval", {
    ...sourceLocation,
    ...artifactLocation,
    stageId: identity,
    approvalId: identity,
  }),
  event("lifecycle", { action: label, generation: nullableCounter }),
]);

const workflowInspectionBudgetSchema = z.object({
  session: z.object({
    policyRevisionId: identity,
    limits: z
      .object({
        maxRepairAttempts: nullableCounter,
        maxExecutionMs: nullableCounter,
        maxTotalTokens: nullableCounter,
        maxCostUsd: decimal.nullish(),
      })
      .nullish(),
    usage: z.object({
      elapsedMs: nullableCounter,
      remainingExecutionMs: nullableCounter,
      repairAttempts: nullableCounter,
      totalTokens: nullableCounter,
      totalCostUsd: decimal.nullish(),
      tokensUnavailable: boolean,
      costUnavailable: boolean,
      tokensUnreported: boolean,
      costUnreported: boolean,
      startedRuns: nullableCounter,
    }),
    exhaustionCode: label,
  }),
  graph: z
    .object({
      limits: z.object({
        maxChildren: counter,
        maxConcurrentChildren: counter,
        maxAttempts: counter,
        maxTotalTokens: counter,
        maxCostUsd: decimal,
      }),
      accountedAttempts: counter,
      accountedTokens: counter,
      accountedSpendUsd: decimal,
      activeChildren: counter,
    })
    .nullable(),
});

export const workflowInspectionCursorSchema = z.object({
  rootSessionId: uuid,
  sessionId: uuid,
  runId: uuid.nullable(),
  recordedAt,
  kind: workflowInspectionEventKind,
  id: receiptId,
});

export const workflowInspectionSchema = workflowInspectionHeaderSchema.extend({
  events: z.array(workflowInspectionEventSchema).max(50),
  budget: workflowInspectionBudgetSchema.nullable(),
  nextCursor: z.string().nullable(),
});

export const workflowInspectionProjectionSchema = workflowInspectionSchema.extend({
  nextCursor: workflowInspectionCursorSchema.nullable(),
});

export type WorkflowInspectionHeader = z.infer<typeof workflowInspectionHeaderSchema>;
export type WorkflowInspectionEvent = z.infer<typeof workflowInspectionEventSchema>;
export type WorkflowInspection = z.infer<typeof workflowInspectionSchema>;
export type WorkflowInspectionCursor = z.infer<typeof workflowInspectionCursorSchema>;
