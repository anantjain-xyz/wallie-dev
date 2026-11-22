import { z } from "zod";

import { modelRoutingConfigurationSchema } from "./contracts";

const id = z.string().uuid().toLowerCase();
const target = z.enum(["primary", "rule_fallback"]);
const activationNumber = z.number().int().safe().positive();

export const routingOverrideSchema = z.strictObject({
  expectedActivationNumber: activationNumber,
  ruleId: id,
  target,
  reason: z.string().trim().min(1, "Enter a reason for the override.").max(500),
});

export const routingOverrideOptionsSchema = z.strictObject({
  activationNumber,
  targets: z.array(
    z.strictObject({
      stageId: id,
      ruleId: id,
      target,
      modelKey: modelRoutingConfigurationSchema.shape.modelKey,
      harness: modelRoutingConfigurationSchema.shape.harness,
      workerRuntime: modelRoutingConfigurationSchema.shape.workerRuntime,
    }),
  ),
});

export type RoutingOverride = z.infer<typeof routingOverrideSchema>;
export type RoutingOverrideOptions = z.infer<typeof routingOverrideOptionsSchema>;
