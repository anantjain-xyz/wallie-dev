import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const factoryAgentPromptSchema = z
  .string()
  .refine(isFactoryDefinitionText, "Use valid Unicode text without NUL characters.")
  .refine((value) => [...value].length <= 20_000, "Keep agent prompts within 20,000 characters.");

export const factoryAgentPromptSnapshotSchema = z
  .object({
    agentId: uuid,
    promptRevisionId: uuid,
    promptMd: factoryAgentPromptSchema,
    promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type FactoryAgentPromptSnapshot = z.infer<typeof factoryAgentPromptSnapshotSchema>;

export const createFactoryAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(120).refine(isFactoryDefinitionText),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    promptMd: factoryAgentPromptSchema.default(""),
  })
  .strict();

export const saveFactoryAgentPromptSchema = z
  .object({
    expectedRevisionNumber: z.number().int().positive().max(2_147_483_646),
    promptMd: factoryAgentPromptSchema,
  })
  .strict();
