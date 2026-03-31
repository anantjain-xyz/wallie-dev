import { z } from "zod";

import { parseClientEnv, type ClientEnv } from "@/env/client";

export const serverEnvSchema = z.object({
  GITHUB_APP_ID: z.string().min(1).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  WALLIE_ENCRYPTION_KEY: z.string().min(32),
  WALLIE_PROCESS_TOKEN: z.string().min(1).optional(),
});
type ServerOnlyEnv = z.infer<typeof serverEnvSchema>;
export type ServerEnv = ClientEnv & ServerOnlyEnv;
type EnvInput = Record<string, string | undefined>;

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
