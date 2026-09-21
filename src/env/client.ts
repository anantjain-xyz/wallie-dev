import { z } from "zod";

export const supabasePublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
});
export type SupabasePublicEnv = z.infer<typeof supabasePublicEnvSchema>;

export const clientEnvSchema = z
  .object({
    NEXT_PUBLIC_APP_URL: z.string().url(),
  })
  .merge(supabasePublicEnvSchema);
export type ClientEnv = z.infer<typeof clientEnvSchema>;
type EnvInput = Record<string, string | undefined>;

// Parse explicit values only. Browser configuration is supplied by the server,
// so Next.js must not inline deployment-specific defaults into client bundles.
export function parseSupabasePublicEnv(input: EnvInput): SupabasePublicEnv {
  return supabasePublicEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: input.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: input.NEXT_PUBLIC_SUPABASE_URL,
  });
}

export function parseClientEnv(input: EnvInput): ClientEnv {
  return clientEnvSchema.parse({
    NEXT_PUBLIC_APP_URL: input.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: input.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: input.NEXT_PUBLIC_SUPABASE_URL,
  });
}
