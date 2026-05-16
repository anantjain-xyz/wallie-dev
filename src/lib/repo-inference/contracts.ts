import { z } from "zod";

import type { Json } from "@/lib/supabase/database.types";

export const REPOSITORY_INFERENCE_CONFIDENCES = ["low", "medium", "high", "manual"] as const;

export const repositoryInferenceConfidenceSchema = z.enum(REPOSITORY_INFERENCE_CONFIDENCES);

export type RepositoryInferenceConfidence = z.infer<typeof repositoryInferenceConfidenceSchema>;

export type RepositoryInferenceSource = {
  path: string;
  reason: string;
};

export type RepositoryProfileState = {
  buildCommand: string | null;
  createdAt: string | null;
  envKeySuggestions: string[];
  frameworkHints: string[];
  githubRepositoryId: string;
  id: string | null;
  inferenceConfidence: RepositoryInferenceConfidence;
  inferenceSources: RepositoryInferenceSource[];
  installCommand: string | null;
  isPrimary: boolean;
  languageHints: string[];
  packageManager: string | null;
  setupNotes: string;
  testCommand: string | null;
  updatedAt: string | null;
  workspaceId: string;
};

export type RepositoryProfileDraft = Omit<
  RepositoryProfileState,
  "createdAt" | "id" | "isPrimary" | "updatedAt" | "workspaceId"
> & {
  id: null;
  isPrimary: true;
  workspaceId: string;
};

const nullableTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}, z.string().max(500).nullable());

const trimmedTextSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().max(5000),
);

const textArraySchema = z
  .array(
    z.preprocess(
      (value) => (typeof value === "string" ? value.trim() : value),
      z.string().min(1).max(120),
    ),
  )
  .max(80)
  .transform((values) => [...new Set(values)]);

const envKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Environment key names must use shell variable syntax.");

export const repositoryProfileSavePayloadSchema = z.object({
  buildCommand: nullableTrimmedStringSchema,
  envKeySuggestions: z
    .array(envKeySchema)
    .max(120)
    .transform((values) => [...new Set(values)]),
  frameworkHints: textArraySchema,
  githubRepositoryId: z.string().uuid("Repository id is invalid."),
  inferenceConfidence: repositoryInferenceConfidenceSchema,
  inferenceSources: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        reason: z.string().min(1).max(200),
      }),
    )
    .max(80),
  installCommand: nullableTrimmedStringSchema,
  languageHints: textArraySchema,
  packageManager: nullableTrimmedStringSchema,
  setupNotes: trimmedTextSchema,
  testCommand: nullableTrimmedStringSchema,
});

export type RepositoryProfileSavePayload = z.infer<typeof repositoryProfileSavePayloadSchema>;

export function normalizeInferenceSources(value: Json): RepositoryInferenceSource[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
      const path = typeof entry.path === "string" ? entry.path : null;
      const reason = typeof entry.reason === "string" ? entry.reason : null;
      return path && reason ? { path, reason } : null;
    })
    .filter((entry): entry is RepositoryInferenceSource => Boolean(entry));
}
