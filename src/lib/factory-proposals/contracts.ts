import { z } from "zod";

import { factoryDefinitionExpectedActivationSchema } from "@/lib/factory-definitions/schema";
import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";
import { modelRoutingConfigurationSchema } from "@/lib/model-routing/contracts";
import { pipelineStageFields } from "@/lib/pipeline/stage-schema";

export const factoryProposalUuidSchema = z.string().uuid().toLowerCase();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const stageOrder = z.array(factoryProposalUuidSchema).min(1).max(200);

export const factoryProposalBaseSchema = z.strictObject({
  activationNumber: factoryDefinitionExpectedActivationSchema.min(1),
  revisionId: factoryProposalUuidSchema,
  digest,
});

export const factoryProposalGrantSchema = z.strictObject({
  stageIds: z.array(factoryProposalUuidSchema),
  agentIds: z.array(factoryProposalUuidSchema),
  skillRevisionIds: z.array(factoryProposalUuidSchema),
  scorerRevisionIds: z.array(factoryProposalUuidSchema),
  routingRuleIds: z.array(factoryProposalUuidSchema),
});

const revisionChange = {
  fromRevisionId: factoryProposalUuidSchema,
  toRevisionId: factoryProposalUuidSchema,
};

export const factoryProposalEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("stage_prompt"),
    stageId: factoryProposalUuidSchema,
    expectedPromptSha256: digest,
    promptTemplateMd: pipelineStageFields.promptTemplateMd
      .removeDefault()
      .refine(isFactoryDefinitionText),
  }),
  z.strictObject({
    kind: z.literal("agent_prompt"),
    agentId: factoryProposalUuidSchema,
    ...revisionChange,
  }),
  z.strictObject({
    kind: z.literal("skill_revision"),
    skillId: factoryProposalUuidSchema,
    ...revisionChange,
  }),
  z.strictObject({
    kind: z.literal("scorer_revision"),
    scorerId: factoryProposalUuidSchema,
    ...revisionChange,
  }),
  z.strictObject({
    kind: z.literal("workflow_order"),
    fromStageIds: stageOrder,
    toStageIds: stageOrder,
  }),
  z.strictObject({
    kind: z.literal("routing_target"),
    ruleId: factoryProposalUuidSchema,
    from: modelRoutingConfigurationSchema,
    to: modelRoutingConfigurationSchema,
  }),
]);

export type FactoryProposalEdit = z.infer<typeof factoryProposalEditSchema>;
export type FactoryProposalGrant = z.infer<typeof factoryProposalGrantSchema>;

function editTarget(edit: FactoryProposalEdit): string {
  switch (edit.kind) {
    case "agent_prompt":
      return edit.kind;
    case "workflow_order":
      return edit.kind;
    case "stage_prompt":
      return `${edit.kind}:${edit.stageId}`;
    case "skill_revision":
      return `${edit.kind}:${edit.skillId}`;
    case "scorer_revision":
      return `${edit.kind}:${edit.scorerId}`;
    case "routing_target":
      return `${edit.kind}:${edit.ruleId}`;
  }
}

const proposalText = z.string().trim().min(1).max(2400).refine(isFactoryDefinitionText);
export const factoryProposalCommandSchema = z
  .strictObject({
    requestId: factoryProposalUuidSchema,
    diagnosisId: factoryProposalUuidSchema,
    proposalId: factoryProposalUuidSchema.optional(),
    expectedRevisionId: factoryProposalUuidSchema.optional(),
    base: factoryProposalBaseSchema,
    rationale: proposalText,
    expectedBenefit: proposalText,
    regressionRisks: z.string().trim().max(2400).refine(isFactoryDefinitionText).default(""),
    edits: z.array(factoryProposalEditSchema).min(1).max(12),
  })
  .superRefine(({ edits, proposalId, expectedRevisionId }, context) => {
    if (Boolean(proposalId) !== Boolean(expectedRevisionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedRevisionId"],
        message: "Choose the exact proposal revision to edit.",
      });
    }
    const targets = new Set<string>();
    edits.forEach((edit, index) => {
      const target = editTarget(edit);
      if (targets.has(target)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edits", index],
          message: "Edit each component only once per revision.",
        });
      }
      targets.add(target);
    });
  });

export type FactoryProposalCommand = z.infer<typeof factoryProposalCommandSchema>;
