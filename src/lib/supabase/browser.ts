"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/supabase/database.types";
import { resolveSupabasePublicConfig } from "@/lib/supabase/config";

export function createSupabaseBrowserClient(
  input: Record<string, string | undefined> = process.env,
) {
  const { anonKey, url } = resolveSupabasePublicConfig(input);

  return createBrowserClient<Database>(url, anonKey);
}

export const createBrowserSupabaseClient = createSupabaseBrowserClient;
