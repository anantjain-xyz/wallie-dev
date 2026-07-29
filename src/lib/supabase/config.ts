import { parseSupabasePublicEnv } from "@/env/client";

export type SupabasePublicConfig = Readonly<{
  publishableKey: string;
  url: string;
}>;

export function resolveSupabasePublicConfig(
  input?: Record<string, string | undefined>,
): SupabasePublicConfig {
  const env = parseSupabasePublicEnv(input);

  return {
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    url: env.NEXT_PUBLIC_SUPABASE_URL,
  };
}
