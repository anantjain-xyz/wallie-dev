import { parseSupabasePublicEnv } from "@/env/client";
import { parseSupabaseAdminEnv } from "@/env/server";

export type SupabasePublicConfig = Readonly<{
  publishableKey: string;
  url: string;
}>;

export type SupabaseAdminConfig = SupabasePublicConfig &
  Readonly<{
    secretKey: string;
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

export function resolveSupabaseAdminConfig(
  input: Record<string, string | undefined> = process.env,
): SupabaseAdminConfig {
  const env = parseSupabaseAdminEnv(input);

  return {
    publishableKey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    secretKey: env.SUPABASE_SECRET_KEY,
    url: env.NEXT_PUBLIC_SUPABASE_URL,
  };
}
