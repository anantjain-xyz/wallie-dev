"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/supabase/database.types";
import { resolveSupabasePublicConfig } from "@/lib/supabase/config";

export function createSupabaseBrowserClient(
  input?: Record<string, string | undefined>,
) {
  const { publishableKey, url } = resolveSupabasePublicConfig(input);

  return createBrowserClient<Database>(url, publishableKey);
}

export const createBrowserSupabaseClient = createSupabaseBrowserClient;
