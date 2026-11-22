import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { factoryResponseHeaders } from "@/lib/factories/route-context";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import type { Database } from "@/lib/supabase/database.types";

import {
  factoryProposalBaseSchema,
  factoryProposalEditSchema,
  factoryProposalGrantSchema,
  factoryProposalUuidSchema,
  type FactoryProposalCommand,
} from "./contracts";
import { compileFactoryProposal } from "./patch";

type Client = SupabaseClient<Database>;
type ProposalScope = {
  client: Client;
  workspaceId: string;
  factoryId: string;
  signal: AbortSignal;
};

const candidateSchema = z.object({
  revisionId: factoryProposalUuidSchema,
  digest: factoryProposalBaseSchema.shape.digest,
  definitionJson: z.string(),
});

const receiptFields = z.object({
  proposalId: factoryProposalUuidSchema,
  revisionId: factoryProposalUuidSchema,
  revisionNumber: z.number().int().positive().safe(),
  previousRevisionId: factoryProposalUuidSchema.nullable(),
  requestId: factoryProposalUuidSchema,
  diagnosisId: factoryProposalUuidSchema,
  base: factoryProposalBaseSchema,
  baseCurrent: z.boolean(),
  rationale: z.string(),
  expectedBenefit: z.string(),
  regressionRisks: z.string(),
  edits: z.array(factoryProposalEditSchema),
  createdAt: z.string().datetime({ offset: true }),
  authorMemberId: factoryProposalUuidSchema,
});

const diagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
});

const diffValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);
const fieldDifference = z.object({
  label: z.string(),
  before: diffValue,
  after: diffValue,
  multiline: z.literal(true).optional(),
});
const stageDifference = z.object({
  id: factoryProposalUuidSchema,
  name: z.string(),
  fields: z.array(fieldDifference),
});
const diffSchema = z.object({
  fields: z.array(fieldDifference),
  stages: z.array(
    z.union([
      stageDifference.extend({
        kind: z.enum(["added", "removed"]),
        position: z.number().int().positive(),
      }),
      stageDifference.extend({
        kind: z.literal("changed"),
        beforePosition: z.number().int().positive(),
        afterPosition: z.number().int().positive(),
        orderChanged: z.boolean(),
      }),
    ]),
  ),
});

const receiptSchema = z.discriminatedUnion("status", [
  receiptFields.extend({
    status: z.literal("compiled"),
    candidate: candidateSchema,
    diff: diffSchema,
    diagnostics: z.tuple([]),
  }),
  receiptFields.extend({
    status: z.literal("invalid"),
    candidate: z.null(),
    diff: z.null(),
    diagnostics: z.array(diagnosticSchema).min(1),
  }),
]);
type ProposalReceipt = z.infer<typeof receiptSchema>;

const preparationSchema = z.union([
  z.object({ replay: receiptSchema }),
  z.object({
    base: factoryProposalBaseSchema.extend({ definitionJson: z.string() }),
    grant: factoryProposalGrantSchema,
  }),
]);

function sameBase(left: FactoryProposalCommand["base"], right: FactoryProposalCommand["base"]) {
  return (
    left.activationNumber === right.activationNumber &&
    left.revisionId === right.revisionId &&
    left.digest === right.digest
  );
}

function receiptForCommand(receipt: ProposalReceipt, command: FactoryProposalCommand) {
  if (
    receipt.requestId !== command.requestId ||
    receipt.diagnosisId !== command.diagnosisId ||
    receipt.previousRevisionId !== (command.expectedRevisionId ?? null) ||
    (command.proposalId !== undefined && receipt.proposalId !== command.proposalId) ||
    !sameBase(receipt.base, command.base)
  ) {
    throw new Error("The saved improvement proposal did not match the command.");
  }
  return receipt;
}

export async function saveFactoryImprovementProposal(
  { client, workspaceId, factoryId, signal }: ProposalScope,
  actorUserId: string,
  command: FactoryProposalCommand,
) {
  const args = {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: actorUserId,
    p_diagnosis_id: command.diagnosisId,
    p_activation_number: command.base.activationNumber,
    p_base_revision_id: command.base.revisionId,
    p_base_digest: command.base.digest,
    p_request_id: command.requestId,
    p_rationale: command.rationale,
    p_expected_benefit: command.expectedBenefit,
    p_regression_risks: command.regressionRisks,
    p_edits: command.edits,
    ...(command.proposalId ? { p_proposal_id: command.proposalId } : {}),
    ...(command.expectedRevisionId ? { p_expected_revision_id: command.expectedRevisionId } : {}),
  };
  const prepared = await client
    .rpc("prepare_factory_improvement_proposal", args)
    .abortSignal(signal);
  if (prepared.error) throw prepared.error;
  const preparation = preparationSchema.parse(prepared.data);
  if ("replay" in preparation) {
    return { proposal: receiptForCommand(preparation.replay, command), replay: true };
  }

  const { base, grant } = preparation;
  if (!sameBase(base, command.base)) throw new Error("The proposal preparation changed its base.");
  const definition = readVerifiedFactoryDefinition(base.definitionJson, base.digest);
  if (!definition) throw new Error("The proposal base does not match its saved definition.");
  const outcome = await compileFactoryProposal({
    client,
    workspaceId,
    factoryId,
    base: definition,
    grant,
    edits: command.edits,
  });

  signal.throwIfAborted();
  const saved = await client
    .rpc("save_factory_improvement_proposal", {
      ...args,
      ...(outcome.ok
        ? {
            p_definition_json: outcome.definitionJson,
            p_candidate_digest: outcome.canonicalDigest,
            p_diff: diffSchema.parse(outcome.diff),
            p_diagnostics: [],
          }
        : { p_diagnostics: z.array(diagnosticSchema).parse(outcome.diagnostics) }),
    })
    .abortSignal(signal);
  if (saved.error) throw saved.error;
  return { proposal: receiptForCommand(receiptSchema.parse(saved.data), command), replay: false };
}

export async function readFactoryImprovementProposal(
  { client, workspaceId, factoryId, signal }: ProposalScope,
  proposalId: string,
  revisionId?: string,
) {
  const result = await client
    .rpc("get_factory_improvement_proposal_revision", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_proposal_id: proposalId,
      ...(revisionId ? { p_revision_id: revisionId } : {}),
    })
    .abortSignal(signal);
  if (result.error) throw result.error;
  if (result.data === null) return null;
  const proposal = receiptSchema.parse(result.data);
  if (proposal.proposalId !== proposalId || (revisionId && proposal.revisionId !== revisionId)) {
    throw new Error("The proposal receipt did not match the requested revision.");
  }
  return proposal;
}

export function factoryProposalResponse(proposal: ProposalReceipt, status = 200) {
  return Response.json({ proposal }, { status, headers: factoryResponseHeaders });
}

export function factoryProposalError(error: string, status: number) {
  return Response.json({ error }, { status, headers: factoryResponseHeaders });
}

export function factoryProposalFailure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "42501":
      return factoryProposalError("You do not have access to this improvement proposal.", 403);
    case "P0002":
      return factoryProposalError("The improvement proposal or diagnosis is unavailable.", 404);
    case "PT409":
    case "P0011":
      return factoryProposalError(
        "The proposal or its active base changed. Reload before retrying.",
        409,
      );
    case "22023":
    case "PT422":
      return factoryProposalError(
        "The proposal requires current, scoped evidence and configuration.",
        422,
      );
    default:
      return factoryProposalError("Could not process the improvement proposal.", 500);
  }
}
