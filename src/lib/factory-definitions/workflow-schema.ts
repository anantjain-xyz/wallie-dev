import { z } from "zod";

import { executionRequirementsSchema } from "@/lib/execution-policy/contracts";
import { pipelineApproversSchema } from "@/lib/pipeline/stage-schema";

export const MAX_WORKFLOW_NODE_VISITS = 1_024;
const MAX_WORKFLOW_NODES = 128;

const workflowNodeIdTextSchema = z
  .string()
  .max(96)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "Use a stable lowercase node ID.");

export const workflowNodeIdSchema = workflowNodeIdTextSchema.brand<"WorkflowNodeId">();

export const workflowEdgeIdSchema = z
  .string()
  .max(96)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "Use a stable lowercase edge ID.")
  .brand<"WorkflowEdgeId">();

const uuid = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

const workflowGrantRevision = z
  .object({ id: uuid, version: z.number().int().positive().safe() })
  .strict();

const node = z.object({ id: workflowNodeIdSchema }).strict();
const agentBinding = { agentPromptRevisionId: uuid, grantId: uuid.optional() };
const workflowNodeSchema = z.discriminatedUnion("kind", [
  node.extend({ kind: z.literal("agent"), ...agentBinding }),
  node.extend({
    kind: z.literal("deterministic"),
    operation: z.enum(["validation", "policy", "checkpoint"]),
  }),
  node.extend({
    kind: z.literal("human-gate"),
    anyoneCanApprove: z.boolean(),
    approverMemberIds: pipelineApproversSchema.transform((ids) =>
      ids.map((id) => id.toLowerCase()),
    ),
  }),
  node.extend({ kind: z.literal("route"), ...agentBinding }),
  node.extend({ kind: z.literal("branch") }),
  node.extend({ kind: z.literal("join") }),
]);

const edge = z
  .object({ id: workflowEdgeIdSchema, from: workflowNodeIdSchema, to: workflowNodeIdSchema })
  .strict();
const workflowEdgeSchema = z.discriminatedUnion("kind", [
  edge.extend({ kind: z.literal("next") }),
  edge.extend({ kind: z.literal("route") }),
  edge.extend({ kind: z.literal("loop"), maxTraversals: z.number().int().min(1).max(16) }),
  edge.extend({ kind: z.literal("branch"), required: z.boolean() }),
  edge.extend({ kind: z.literal("branch-result") }),
]);

const workflowRouteFallbackSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("route"), destinationId: workflowNodeIdSchema }).strict(),
  z.object({ kind: z.literal("clarification") }).strict(),
]);
const workflowProfileRevisionSchema = z
  .object({
    definitionRevisionId: uuid,
    definitionDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

function hasBoundedNodeMapSize(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  // Match the record parser's enumerable keys without reading entry values.
  const keys = new Set<string>();
  for (const key in value) {
    keys.add(key);
    if (keys.size > MAX_WORKFLOW_NODES) return false;
  }
  return true;
}

const workflowRoutePoliciesByNodeSchema = z
  .unknown()
  .refine(hasBoundedNodeMapSize, `Declare at most ${MAX_WORKFLOW_NODES} route policy entries.`)
  .pipe(
    z.record(
      workflowNodeIdTextSchema,
      z
        .object({
          minimumConfidence: z.number().finite().min(0).max(1),
          allowedDestinationIds: z.array(workflowNodeIdSchema).max(MAX_WORKFLOW_NODES),
          fallback: workflowRouteFallbackSchema,
          foremanProfile: workflowProfileRevisionSchema.optional(),
        })
        .strict(),
    ),
  );
const workflowRoutePolicySchema = z
  .object({
    maxNodeVisits: z.number().int().min(1).max(MAX_WORKFLOW_NODE_VISITS),
    maxLoopTraversals: z.number().int().min(0).max(MAX_WORKFLOW_NODE_VISITS),
    nodes: workflowRoutePoliciesByNodeSchema,
  })
  .strict();

const delegationCount = z.number().int().min(1).max(MAX_WORKFLOW_NODE_VISITS);
const delegationTokens = executionRequirementsSchema.shape.maxTotalTokens.unwrap();
const delegationCost = executionRequirementsSchema.shape.maxCostUsd.unwrap();
const workflowDelegationPolicySchema = z
  .object({
    maxChildren: delegationCount,
    maxConcurrentChildren: delegationCount,
    maxAttempts: delegationCount,
    maxTotalTokens: delegationTokens,
    maxCostUsd: delegationCost,
    maxTokensPerAttempt: delegationTokens,
    maxCostUsdPerAttempt: delegationCost,
    targets: z
      .unknown()
      .refine(hasBoundedNodeMapSize, `Declare at most ${MAX_WORKFLOW_NODES} delegation targets.`)
      .pipe(z.record(workflowNodeIdTextSchema, workflowProfileRevisionSchema)),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.maxConcurrentChildren > policy.maxChildren)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxConcurrentChildren"],
        message: "Concurrent children cannot exceed the total child limit.",
      });
    if (policy.maxChildren > policy.maxAttempts)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxChildren"],
        message: "Children cannot exceed the total attempt limit.",
      });
    if (policy.maxTokensPerAttempt > policy.maxTotalTokens)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxTokensPerAttempt"],
        message: "An attempt cannot reserve more than the total token limit.",
      });
    if (policy.maxCostUsdPerAttempt > policy.maxCostUsd)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxCostUsdPerAttempt"],
        message: "An attempt cannot reserve more than the total spend limit.",
      });
  });

const workflowRepositorySetSchema = z
  .array(
    z
      .object({
        repositoryId: uuid,
        writerGrant: workflowGrantRevision,
        branchEdgeIds: z.array(workflowEdgeIdSchema).min(1).max(MAX_WORKFLOW_NODES),
      })
      .strict(),
  )
  .min(1)
  .max(8);

const workflowRepositorySetsSchema = z
  .unknown()
  .refine(hasBoundedNodeMapSize, `Declare at most ${MAX_WORKFLOW_NODES} repository sets.`)
  .pipe(z.record(workflowNodeIdTextSchema, workflowRepositorySetSchema));

export const workflowGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("graph"),
    entryNodeId: workflowNodeIdSchema,
    nodes: z.array(workflowNodeSchema).min(1).max(MAX_WORKFLOW_NODES),
    edges: z.array(workflowEdgeSchema).max(512),
    grants: z.array(workflowGrantRevision).max(128),
    routePolicy: workflowRoutePolicySchema.optional(),
    delegationPolicy: workflowDelegationPolicySchema.optional(),
    repositorySets: workflowRepositorySetsSchema.optional(),
  })
  .strict();

export type WorkflowGraphDefinition = z.output<typeof workflowGraphSchema>;
export type WorkflowRoutePolicy = z.output<typeof workflowRoutePolicySchema>;
export type WorkflowDelegationPolicy = z.output<typeof workflowDelegationPolicySchema>;
export type WorkflowNodeId = z.output<typeof workflowNodeIdSchema>;

export type WorkflowDiagnostic = {
  path: readonly (string | number)[];
  code:
    | "invalid_json"
    | "invalid_schema"
    | "duplicate_id"
    | "missing_reference"
    | "invalid_edge"
    | "unreachable_node"
    | "invalid_join"
    | "invalid_repository_set"
    | "unbounded_cycle"
    | "invalid_loop"
    | "invalid_route_policy"
    | "invalid_delegation_policy"
    | "expansion_limit"
    | "invalid_grant";
  message: string;
};
