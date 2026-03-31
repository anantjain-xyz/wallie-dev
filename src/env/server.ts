import { z } from "zod";

import { clientEnvSchema } from "@/env/client";

export const serverEnvSchema = clientEnvSchema.extend({
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  WALLIE_ENCRYPTION_KEY: z.string().min(32),
  WALLIE_PROCESS_TOKEN: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
type EnvInput = Record<string, string | undefined>;

export function parseServerEnv(input: EnvInput = process.env): ServerEnv {
  return serverEnvSchema.parse({
    NEXT_PUBLIC_APP_URL: input.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: input.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_URL: input.NEXT_PUBLIC_SUPABASE_URL,
    GITHUB_APP_ID: input.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: input.GITHUB_APP_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: input.GITHUB_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY: input.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: input.STRIPE_WEBHOOK_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: input.SUPABASE_SERVICE_ROLE_KEY,
    WALLIE_ENCRYPTION_KEY: input.WALLIE_ENCRYPTION_KEY,
    WALLIE_PROCESS_TOKEN: input.WALLIE_PROCESS_TOKEN,
  });
}
