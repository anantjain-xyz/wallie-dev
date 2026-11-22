import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

import { factoryProposalUuidSchema as id } from "./contracts";

const reviewVersion = z.number().int().nonnegative().max(2_147_483_647);
const reviewAction = z.enum(["comment", "investigate", "revise", "dismiss"]);
const note = z.string().trim().max(4000).refine(isFactoryDefinitionText);

export const proposalReviewDispositionSchema = z.enum([
  "open",
  "investigate",
  "revise",
  "dismissed",
]);

export const proposalReviewCommandSchema = z
  .strictObject({
    proposalRevisionId: id,
    expectedReviewVersion: reviewVersion,
    requestId: id,
    action: reviewAction,
    note: note.default(""),
  })
  .refine(({ action, note }) => action !== "comment" || note.length > 0, {
    path: ["note"],
    message: "Enter a comment before sending it.",
  });

export const proposalReviewEventSchema = z.object({
  id,
  version: reviewVersion.min(1),
  action: reviewAction,
  note: z.string(),
  actorMemberId: id,
  actorName: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

export const proposalReviewSaveSchema = z.object({
  event: proposalReviewEventSchema,
  replay: z.boolean(),
});

export type ProposalReviewAction = z.infer<typeof reviewAction>;
export type ProposalReviewEvent = z.infer<typeof proposalReviewEventSchema>;
export type ProposalReviewCommand = z.infer<typeof proposalReviewCommandSchema>;
