import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import { factoryProposalUuidSchema as id } from "./contracts";
import { factoryProposalReceiptSchema } from "./server";
import {
  proposalReviewDispositionSchema,
  proposalReviewEventSchema,
  proposalReviewSaveSchema,
  type ProposalReviewCommand,
  type ProposalReviewDisposition,
} from "./workbench-contracts";

type Client = Pick<SupabaseClient<Database>, "rpc">;
type FactoryScope = { workspaceId: string; factoryId: string };

const revisionSummary = z.object({
  revisionId: id,
  revisionNumber: z.number().int().positive(),
  status: z.enum(["compiled", "invalid"]),
  createdAt: z.string().datetime({ offset: true }),
});

const listSchema = z.object({
  proposals: z.array(
    revisionSummary.extend({
      proposalId: id,
      diagnosisId: id,
      cohortId: id.nullable(),
      rationale: z.string(),
      expectedBenefit: z.string(),
      baseCurrent: z.boolean(),
      disposition: proposalReviewDispositionSchema,
    }),
  ),
  nextProposalId: id.nullable(),
});

const workbenchSchema = z.object({
  proposal: factoryProposalReceiptSchema,
  latestRevisionId: id,
  revisions: z.array(revisionSummary),
  cohortId: id.nullable(),
  review: z.object({
    version: z.number().int().nonnegative(),
    disposition: proposalReviewDispositionSchema,
    canReview: z.boolean(),
    events: z.array(proposalReviewEventSchema),
    nextEventBefore: z.number().int().positive().nullable(),
  }),
});

export type ImprovementProposalList = z.infer<typeof listSchema>;
export type ImprovementWorkbench = z.infer<typeof workbenchSchema>;

export async function listImprovementProposals(
  client: Client,
  { workspaceId, factoryId }: FactoryScope,
  {
    after,
    cohortId,
    reviewState,
  }: { after?: string; cohortId?: string; reviewState?: ProposalReviewDisposition } = {},
): Promise<ImprovementProposalList> {
  const { data, error } = await client.rpc("list_factory_improvement_workbench", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    ...(after ? { p_after_proposal_id: after } : {}),
    ...(cohortId ? { p_cohort_id: cohortId } : {}),
    ...(reviewState ? { p_review_state: reviewState } : {}),
  });
  if (error) throw error;
  return listSchema.parse(data);
}

export async function readImprovementWorkbench(
  client: Client,
  { workspaceId, factoryId }: FactoryScope,
  {
    proposalId,
    revisionId,
    beforeEvent,
  }: { proposalId: string; revisionId?: string; beforeEvent?: number },
): Promise<ImprovementWorkbench | null> {
  const { data, error } = await client.rpc("read_factory_improvement_workbench", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_proposal_id: proposalId,
    ...(revisionId ? { p_revision_id: revisionId } : {}),
    ...(beforeEvent !== undefined ? { p_before_event: beforeEvent } : {}),
  });
  if (error?.code === "P0002") return null;
  if (error) throw error;
  if (data === null) return null;
  const workbench = workbenchSchema.parse(data);
  if (
    workbench.proposal.proposalId !== proposalId ||
    (revisionId !== undefined && workbench.proposal.revisionId !== revisionId) ||
    (revisionId === undefined && workbench.proposal.revisionId !== workbench.latestRevisionId)
  ) {
    throw new Error("The workbench returned a different improvement proposal revision.");
  }
  return workbench;
}

export async function saveImprovementReview(
  client: Client,
  { workspaceId, factoryId }: FactoryScope,
  actorUserId: string,
  proposalId: string,
  command: ProposalReviewCommand,
  signal: AbortSignal,
) {
  const { data, error } = await client
    .rpc("save_factory_improvement_review_event", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_actor_user_id: actorUserId,
      p_proposal_id: proposalId,
      p_proposal_revision_id: command.proposalRevisionId,
      p_expected_review_version: command.expectedReviewVersion,
      p_request_id: command.requestId,
      p_action: command.action,
      p_note: command.note,
    })
    .abortSignal(signal);
  if (error) throw error;
  const saved = proposalReviewSaveSchema.parse(data);
  if (
    saved.event.version !== command.expectedReviewVersion + 1 ||
    saved.event.action !== command.action ||
    saved.event.note !== command.note
  ) {
    throw new Error("The saved proposal review did not match the submitted decision.");
  }
  return saved;
}
