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

export const serverEnvSchema = z.object({
  GITHUB_APP_ID: optionalEnvStringSchema,
  GITHUB_APP_PRIVATE_KEY: optionalEnvStringSchema,
  GITHUB_WEBHOOK_SECRET: optionalEnvStringSchema,
  SLACK_CLIENT_ID: optionalEnvStringSchema,
  SLACK_CLIENT_SECRET: optionalEnvStringSchema,
  SLACK_SIGNING_SECRET: optionalEnvStringSchema,
  SUPABASE_SECRET_KEY: requiredEnvStringSchema,
  WALLIE_ENCRYPTION_KEY: z.string().min(32),
  WALLIE_PROCESS_TOKEN: optionalEnvStringSchema,
  // Vercel Sandbox credentials for agent execution. All three required in
  // environments that don't run on Vercel infra (where OIDC is used instead).
  VERCEL_TOKEN: optionalEnvStringSchema,
  VERCEL_TEAM_ID: optionalEnvStringSchema,
  VERCEL_PROJECT_ID: optionalEnvStringSchema,
  // "vercel" (default) or "fake" (tests). Any other value throws at runtime.
  WALLIE_SANDBOX_IMPL: optionalEnvStringSchema,
  // Optional Upstash REST credentials for distributed rate limiting. When
  // unset, the rate limiter falls back to a per-instance in-memory store.
  UPSTASH_REDIS_REST_URL: optionalEnvStringSchema,
  UPSTASH_REDIS_REST_TOKEN: optionalEnvStringSchema,
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
    SLACK_CLIENT_ID: input.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: input.SLACK_CLIENT_SECRET,
    SLACK_SIGNING_SECRET: input.SLACK_SIGNING_SECRET,
    SUPABASE_SECRET_KEY: input.SUPABASE_SECRET_KEY,
    WALLIE_ENCRYPTION_KEY: input.WALLIE_ENCRYPTION_KEY,
    WALLIE_PROCESS_TOKEN: input.WALLIE_PROCESS_TOKEN,
    VERCEL_TOKEN: input.VERCEL_TOKEN,
    VERCEL_TEAM_ID: input.VERCEL_TEAM_ID,
    VERCEL_PROJECT_ID: input.VERCEL_PROJECT_ID,
    WALLIE_SANDBOX_IMPL: input.WALLIE_SANDBOX_IMPL,
    UPSTASH_REDIS_REST_URL: input.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: input.UPSTASH_REDIS_REST_TOKEN,
  });

  return {
    ...clientEnv,
    ...serverEnv,
  };
}
