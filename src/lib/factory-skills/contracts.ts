import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

const uuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

export const factorySkillRevisionIdSchema = uuidSchema;
export const MAX_FACTORY_SKILL_REVISIONS = 20;

const repositoryPathSchema = z
  .string()
  .min(1)
  .max(900)
  .refine(isFactoryDefinitionText)
  .refine(
    (path) =>
      !/[:\\\p{Cc}]/u.test(path) &&
      path.split("/").every((segment) => segment && segment !== "." && segment !== ".."),
    "Provide a file path within the repository.",
  );

const skillSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual") }).strict(),
    z
      .object({
        kind: z.literal("repository"),
        repositoryId: uuidSchema,
        commitSha: z
          .string()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i)
          .transform((sha) => sha.toLowerCase()),
        path: repositoryPathSchema,
      })
      .strict(),
  ])
  .default({ kind: "manual" });

const contentMd = z
  .string()
  .refine(isFactoryDefinitionText, "Use valid Unicode text without NUL characters.")
  .refine((value) => /\S/.test(value), "Provide nonempty skill content.")
  .refine((value) => [...value].length <= 20_000, "Keep skill content within 20,000 characters.");

export const createFactorySkillSchema = z
  .object({
    name: z.string().trim().min(1).max(120).refine(isFactoryDefinitionText),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    contentMd,
    source: skillSourceSchema,
  })
  .strict();

export const saveFactorySkillRevisionSchema = z
  .object({
    expectedRevisionNumber: z.number().int().positive().max(2_147_483_646),
    contentMd,
    source: skillSourceSchema,
  })
  .strict();

export type FactorySkillSource = z.output<typeof skillSourceSchema>;
