import { z } from "zod";

import {
  parseClientEnv,
  parseSupabasePublicEnv,
  supabasePublicEnvSchema,
  type ClientEnv,
} from "@/env/client";

const requiredEnvStringSchema = z.string().min(1);
const optionalEnvStringSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  requiredEnvStringSchema.optional(),
);

// Accepts hex with >=32 bytes (>=64 chars), or base64/base64url with >=32
// bytes encoded (>=43 chars). Rejects human-typed phrases that happen to be
// >=32 chars but contain whitespace, punctuation, or insufficient entropy
// shape. Generate via `openssl rand -hex 32` or `openssl rand -base64 32`.
const hexEncryptionKeyShape = /^[0-9a-fA-F]{64,}$/;
const base64EncryptionKeyShape = /^[A-Za-z0-9+/_-]{43,}={0,2}$/;
const encryptionKeyShapeMessage =
  "WALLIE_ENCRYPTION_KEY must be hex-encoded (>=64 chars) or base64-encoded (>=43 chars). Generate with `openssl rand -hex 32`.";

export const serverEnvSchema = z.object({
  GITHUB_APP_ID: optionalEnvStringSchema,
  GITHUB_APP_PRIVATE_KEY: optionalEnvStringSchema,
  GITHUB_WEBHOOK_SECRET: optionalEnvStringSchema,
  SUPABASE_SECRET_KEY: requiredEnvStringSchema,
  WALLIE_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => hexEncryptionKeyShape.test(value) || base64EncryptionKeyShape.test(value),
      encryptionKeyShapeMessage,
    ),
  // Vercel Sandbox credentials for agent execution. All three required in
  // environments that don't run on Vercel infra (where OIDC is used instead).
  VERCEL_TOKEN: optionalEnvStringSchema,
  VERCEL_TEAM_ID: optionalEnvStringSchema,
  VERCEL_PROJECT_ID: optionalEnvStringSchema,
  // "vercel" (default) or "fake" (tests). Any other value throws at runtime.
  WALLIE_SANDBOX_IMPL: optionalEnvStringSchema,
});
type ServerOnlyEnv = z.infer<typeof serverEnvSchema>;
export type ServerEnv = ClientEnv & ServerOnlyEnv;
export const supabaseAdminEnvSchema = supabasePublicEnvSchema.extend({
  SUPABASE_SECRET_KEY: requiredEnvStringSchema,
});
export type SupabaseAdminEnv = z.infer<typeof supabaseAdminEnvSchema>;
type EnvInput = Record<string, string | undefined>;

export function parseSupabaseAdminEnv(input: EnvInput = process.env): SupabaseAdminEnv {
  const publicEnv = parseSupabasePublicEnv(input);

  return supabaseAdminEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SECRET_KEY: input.SUPABASE_SECRET_KEY,
  });
}

export function parseServerEnv(input: EnvInput = process.env): ServerEnv {
  const clientEnv = parseClientEnv(input);
  const serverEnv = serverEnvSchema.parse({
    GITHUB_APP_ID: input.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: input.GITHUB_APP_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: input.GITHUB_WEBHOOK_SECRET,
    SUPABASE_SECRET_KEY: input.SUPABASE_SECRET_KEY,
    WALLIE_ENCRYPTION_KEY: input.WALLIE_ENCRYPTION_KEY,
    VERCEL_TOKEN: input.VERCEL_TOKEN,
    VERCEL_TEAM_ID: input.VERCEL_TEAM_ID,
    VERCEL_PROJECT_ID: input.VERCEL_PROJECT_ID,
    WALLIE_SANDBOX_IMPL: input.WALLIE_SANDBOX_IMPL,
  });

  return {
    ...clientEnv,
    ...serverEnv,
  };
}
