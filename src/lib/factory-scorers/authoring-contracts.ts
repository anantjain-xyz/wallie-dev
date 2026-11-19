import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

import { factoryScorerDefinitionSchema } from "./contracts";

const maxRevisionNumber = 2_147_483_647;

export const createFactoryScorerSchema = z.strictObject({
  name: z
    .string({ required_error: "Enter a scorer name.", invalid_type_error: "Enter a scorer name." })
    .trim()
    .refine(
      (name) => isFactoryDefinitionText(name) && [...name].length <= 120 && name.length > 0,
      "Enter a scorer name between 1 and 120 characters.",
    ),
  slug: z
    .string({
      required_error: "Enter a scorer identifier.",
      invalid_type_error: "Enter a scorer identifier.",
    })
    .trim()
    .max(60, "Keep the identifier within 60 characters.")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens."),
  definition: factoryScorerDefinitionSchema,
});

export const saveFactoryScorerRevisionSchema = z.strictObject({
  expectedRevisionNumber: z
    .number()
    .int()
    .min(1)
    .max(maxRevisionNumber - 1, "This scorer cannot append another revision."),
  definition: factoryScorerDefinitionSchema,
});

export const scorerRevisionSchema = z.object({
  id: z.string().uuid(),
  scorer_id: z.string().uuid(),
  revision_number: z.number().int().min(1).max(maxRevisionNumber),
  definition: factoryScorerDefinitionSchema,
  created_at: z.string().datetime({ offset: true }),
});

export const scorerRevisionMutationResponseSchema = z.object({ revision: scorerRevisionSchema });
