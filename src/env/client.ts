import { z } from "zod";

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
type EnvInput = Record<string, string | undefined>;

export function parseClientEnv(input: EnvInput = process.env): ClientEnv {
  return clientEnvSchema.parse({
    NEXT_PUBLIC_APP_URL: input.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: input.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SUPABASE_URL: input.NEXT_PUBLIC_SUPABASE_URL,
  });
}
