import "server-only";

import { createClient } from "@supabase/supabase-js";

import { resolveSupabaseAdminConfig } from "@/lib/supabase/admin-config";
import type { Database } from "@/lib/supabase/database.types";

export function createSupabaseAdminClient(input: Record<string, string | undefined> = process.env) {
  const { secretKey, url } = resolveSupabaseAdminConfig(input);

  return createClient<Database>(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export const createAdminSupabaseClient = createSupabaseAdminClient;
