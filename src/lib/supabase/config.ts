import { parseClientEnv } from "@/env/client";
import { parseServerEnv } from "@/env/server";

export type SupabasePublicConfig = Readonly<{
  anonKey: string;
  url: string;
}>;

export type SupabaseAdminConfig = SupabasePublicConfig &
  Readonly<{
    serviceRoleKey: string;
  }>;

export function resolveSupabasePublicConfig(
  input: Record<string, string | undefined> = process.env,
): SupabasePublicConfig {
  const env = parseClientEnv(input);

  return {
    anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    url: env.NEXT_PUBLIC_SUPABASE_URL,
  };
}

export function resolveSupabaseAdminConfig(
  input: Record<string, string | undefined> = process.env,
): SupabaseAdminConfig {
  const env = parseServerEnv(input);

  return {
    anonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    url: env.NEXT_PUBLIC_SUPABASE_URL,
  };
}
