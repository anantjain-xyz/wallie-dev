import { z } from "zod";

import { modelRoutingConfigurationSchema } from "./contracts";

const id = z.string().uuid();

export const routingQualificationStatusSchema = z.strictObject({
  activationNumber: z.number().int().safe().positive().nullable(),
  draftId: id.nullable(),
  revisionId: id.nullable(),
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["current", "stale"]),
  reasons: z.array(z.string()),
  baseline: z
    .strictObject({
      activationNumber: z.number().int().safe().positive(),
      revisionId: id,
      status: z.enum(["current", "stale"]),
      reasons: z.array(z.string()),
    })
    .optional(),
  targets: z.array(
    z.strictObject({
      ruleId: id.nullable(),
      taskClassId: id.nullable(),
      target: z.enum(["primary", "rule_fallback", "unmatched_fallback"]),
      configuration: modelRoutingConfigurationSchema,
      reasons: z.array(z.string()),
    }),
  ),
});

export type RoutingQualificationStatus = z.infer<typeof routingQualificationStatusSchema>;
