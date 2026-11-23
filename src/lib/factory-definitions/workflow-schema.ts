import { z } from "zod";

import { pipelineApproversSchema } from "@/lib/pipeline/stage-schema";

export const MAX_WORKFLOW_NODE_VISITS = 1_024;

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
const workflowRoutePolicySchema = z
  .object({
    maxNodeVisits: z.number().int().min(1).max(MAX_WORKFLOW_NODE_VISITS),
    maxLoopTraversals: z.number().int().min(0).max(MAX_WORKFLOW_NODE_VISITS),
    nodes: z.record(
      workflowNodeIdTextSchema,
      z
        .object({
          minimumConfidence: z.number().finite().min(0).max(1),
          allowedDestinationIds: z.array(workflowNodeIdSchema).max(128),
          fallback: workflowRouteFallbackSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const workflowGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("graph"),
    entryNodeId: workflowNodeIdSchema,
    nodes: z.array(workflowNodeSchema).min(1).max(128),
    edges: z.array(workflowEdgeSchema).max(512),
    grants: z
      .array(z.object({ id: uuid, version: z.number().int().positive().safe() }).strict())
      .max(128),
    routePolicy: workflowRoutePolicySchema.optional(),
  })
  .strict();

export type WorkflowGraphDefinition = z.output<typeof workflowGraphSchema>;
export type WorkflowRoutePolicy = z.output<typeof workflowRoutePolicySchema>;
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
    | "unbounded_cycle"
    | "invalid_loop"
    | "invalid_route_policy"
    | "expansion_limit"
    | "invalid_grant";
  message: string;
};
