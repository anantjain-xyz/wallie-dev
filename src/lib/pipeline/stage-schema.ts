import { z } from "zod";

export const pipelineStageFields = {
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  promptTemplateMd: z.string().max(20_000).default(""),
};

export const pipelineApproversSchema = z.array(z.string().uuid()).default([]);
export const pipelineOperatingRulesSchema = z.string().max(20_000);
