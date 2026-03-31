import { z } from "zod";

import {
  parseClientEnv,
  parseSupabasePublicEnv,
  supabasePublicEnvSchema,
  type ClientEnv,
} from "@/env/client";

const requiredEnvStringSchema = z.string().min(1);
const optionalEnvStringSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  requiredEnvStringSchema.optional(),
);

export const serverEnvSchema = z.object({
  GITHUB_APP_ID: optionalEnvStringSchema,
  GITHUB_APP_PRIVATE_KEY: optionalEnvStringSchema,
  GITHUB_WEBHOOK_SECRET: optionalEnvStringSchema,
  STRIPE_SECRET_KEY: optionalEnvStringSchema,
  STRIPE_WEBHOOK_SECRET: optionalEnvStringSchema,
  SUPABASE_SECRET_KEY: requiredEnvStringSchema,
  WALLIE_ENCRYPTION_KEY: z.string().min(32),
  WALLIE_PROCESS_TOKEN: optionalEnvStringSchema,
});
type ServerOnlyEnv = z.infer<typeof serverEnvSchema>;
export type ServerEnv = ClientEnv & ServerOnlyEnv;
export const supabaseAdminEnvSchema = supabasePublicEnvSchema.extend({
  SUPABASE_SECRET_KEY: requiredEnvStringSchema,
});
export type SupabaseAdminEnv = z.infer<typeof supabaseAdminEnvSchema>;
type EnvInput = Record<string, string | undefined>;

export function parseSupabaseAdminEnv(
  input: EnvInput = process.env,
): SupabaseAdminEnv {
  const publicEnv = parseSupabasePublicEnv(input);

  return supabaseAdminEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
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
    STRIPE_SECRET_KEY: input.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: input.STRIPE_WEBHOOK_SECRET,
    SUPABASE_SECRET_KEY: input.SUPABASE_SECRET_KEY,
    WALLIE_ENCRYPTION_KEY: input.WALLIE_ENCRYPTION_KEY,
    WALLIE_PROCESS_TOKEN: input.WALLIE_PROCESS_TOKEN,
  });

  return {
    ...clientEnv,
    ...serverEnv,
  };
}
