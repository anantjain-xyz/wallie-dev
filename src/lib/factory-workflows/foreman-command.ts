import { z } from "zod/v4";

import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { workflowNodeIdSchema } from "@/lib/factory-definitions/workflow-schema";

import { workflowDelegationRequestSchema } from "./delegation-request";
import { workflowRouteProposalSchema } from "./route-decision";

const maxForemanPlanBytes = 24 * 1024;

const routeCommandSchema = z.strictObject({
  kind: z.literal("route"),
  decision: workflowRouteProposalSchema.shape.decision,
});
const delegateCommandSchema = z.strictObject({
  kind: z.literal("delegate"),
  targetNodeId: z.string().refine((id) => workflowNodeIdSchema.safeParse(id).success),
  ...workflowDelegationRequestSchema.shape,
});
const readChildCommandSchema = z.strictObject({
  kind: z.literal("read_child"),
  childRef: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
});
const foremanPlanSchema = z.strictObject({
  version: z.literal(1),
  commands: z.union([
    z.tuple([z.discriminatedUnion("kind", [routeCommandSchema, readChildCommandSchema])]),
    z.tuple([routeCommandSchema, delegateCommandSchema]),
  ]),
});

export type ForemanPlan = z.output<typeof foremanPlanSchema>;
type DelegateCommand = z.output<typeof delegateCommandSchema>;
type ReadChildCommand = z.output<typeof readChildCommandSchema>;

export function parseForemanPlan(source: string) {
  if (
    source.length > maxForemanPlanBytes ||
    new TextEncoder().encode(source).byteLength > maxForemanPlanBytes
  ) {
    return { status: "blocked", code: "plan_too_large" } as const;
  }
  const decoded = parseFactoryDefinitionJson(source);
  const parsed = foremanPlanSchema.safeParse(decoded.ok ? decoded.value : null);
  if (!parsed.success) return { status: "blocked", code: "invalid_plan" } as const;
  const commands = parsed.data.commands;
  if (
    commands.length === 2 &&
    (commands[0].decision.kind !== "choose" ||
      commands[0].decision.destinationNodeId !== commands[1].targetNodeId)
  ) {
    return { status: "blocked", code: "inconsistent_target" } as const;
  }
  return { status: "parsed", plan: parsed.data } as const;
}

type RunScope = {
  rootSessionId: string;
  routeOccurrenceId: string;
  foremanRunId: string;
};

/** The adapter validates this projection of the scoped OP-646 receipt. */
type PersistedRouteDecision =
  | { resolution: "clarification"; rootSessionId: string; routeOccurrenceId: string }
  | {
      resolution: "selected" | "fallback";
      rootSessionId: string;
      routeOccurrenceId: string;
      decisionId: string;
      selectedDestinationId: string;
      targetOccurrenceId: string;
    };

/** Assemble references solely from the observed execution's declared target and durable route receipt. */
export function bindForemanDelegation({
  scope,
  command,
  decision,
  declaredTargetIds,
}: {
  scope: RunScope;
  command: DelegateCommand;
  decision: PersistedRouteDecision | null;
  declaredTargetIds: ReadonlySet<string>;
}) {
  if (
    !decision ||
    decision.resolution === "clarification" ||
    decision.rootSessionId !== scope.rootSessionId ||
    decision.routeOccurrenceId !== scope.routeOccurrenceId ||
    decision.selectedDestinationId !== command.targetNodeId ||
    !declaredTargetIds.has(command.targetNodeId)
  ) {
    return { status: "blocked", code: "no_authorized_target" } as const;
  }
  return {
    status: "bound",
    foremanRunId: scope.foremanRunId,
    decisionId: decision.decisionId,
    targetOccurrenceId: decision.targetOccurrenceId,
    work: { title: command.title, promptMd: command.promptMd },
  } as const;
}

/** The offered map is a bounded projection of children owned by the exact parent and root. */
export function bindForemanChildRead(
  command: ReadChildCommand,
  offeredChildren: ReadonlyMap<string, { childSessionId: string; targetOccurrenceId: string }>,
) {
  const child = offeredChildren.get(command.childRef);
  return child
    ? ({ status: "bound", child } as const)
    : ({ status: "blocked", code: "child_unavailable" } as const);
}
