import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { resolveSupabaseAdminConfig } from "@/lib/supabase/config";

export function createSupabaseAdminClient(
  input: Record<string, string | undefined> = process.env,
) {
  const { secretKey, url } = resolveSupabaseAdminConfig(input);

  return createClient<Database>(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export const createAdminSupabaseClient = createSupabaseAdminClient;
