import { z } from "zod/v4";

import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";

const MAX_ROUTE_PROPOSAL_BYTES = 4_096;
const confidence = z.number().min(0).max(1);
const reason = z.string().max(512).regex(/\S/);

// Keep the provider envelope an object with a bounded response shape. The
// explanation is untrusted data and never supplies an execution decision.
export const workflowRouteProposalSchema = z.strictObject({
  version: z.literal(1),
  decision: z.union([
    z.strictObject({
      kind: z.literal("choose"),
      destinationNodeId: z.string().min(1).max(96),
      confidence,
      reason,
    }),
    z.strictObject({ kind: z.literal("unresolved"), reason }),
  ]),
});

export type WorkflowRouteProposal = z.output<typeof workflowRouteProposalSchema>["decision"];
type ParseResult =
  | { ok: true; proposal: WorkflowRouteProposal }
  | { ok: false; code: "invalid_proposal" | "proposal_too_large" };

export function parseWorkflowRouteProposal(source: string): ParseResult {
  if (
    source.length > MAX_ROUTE_PROPOSAL_BYTES ||
    new TextEncoder().encode(source).byteLength > MAX_ROUTE_PROPOSAL_BYTES
  )
    return { ok: false, code: "proposal_too_large" };

  const decoded = parseFactoryDefinitionJson(source);
  if (!decoded.ok) return { ok: false, code: "invalid_proposal" };
  const parsed = workflowRouteProposalSchema.safeParse(decoded.value);
  return parsed.success
    ? { ok: true, proposal: parsed.data.decision }
    : { ok: false, code: "invalid_proposal" };
}
