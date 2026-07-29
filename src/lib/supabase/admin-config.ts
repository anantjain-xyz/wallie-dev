import "server-only";

import { parseSupabaseAdminEnv } from "@/env/server";
import type { SupabasePublicConfig } from "@/lib/supabase/config";

export type SupabaseAdminConfig = SupabasePublicConfig &
  Readonly<{
    secretKey: string;
  }>;

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
