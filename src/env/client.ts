import { z } from "zod";

export const supabasePublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
});
export type SupabasePublicEnv = z.infer<typeof supabasePublicEnvSchema>;

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url(),
}).merge(supabasePublicEnvSchema);
export type ClientEnv = z.infer<typeof clientEnvSchema>;
type EnvInput = Record<string, string | undefined>;

function resolveClientEnvInput(input?: EnvInput): EnvInput {
  if (input) {
    return input;
  }

  // Next.js only inlines NEXT_PUBLIC_* env values into client bundles when the
  // properties are referenced directly.
  return {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  };
}

export function parseSupabasePublicEnv(input?: EnvInput): SupabasePublicEnv {
  const resolvedInput = resolveClientEnvInput(input);

  return supabasePublicEnvSchema.parse({
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      resolvedInput.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: resolvedInput.NEXT_PUBLIC_SUPABASE_URL,
  });
}

export function parseClientEnv(input?: EnvInput): ClientEnv {
  const resolvedInput = resolveClientEnvInput(input);

  return clientEnvSchema.parse({
    NEXT_PUBLIC_APP_URL: resolvedInput.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      resolvedInput.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: resolvedInput.NEXT_PUBLIC_SUPABASE_URL,
  });
}
