"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/supabase/database.types";
import type { SupabasePublicConfig } from "@/lib/supabase/config";

export function createSupabaseBrowserClient(config: SupabasePublicConfig | null) {
  if (!config) {
    throw new Error(
      "Supabase public configuration is missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY at runtime.",
    );
  }

  const { publishableKey, url } = config;

  return createBrowserClient<Database>(url, publishableKey);
}

export const createBrowserSupabaseClient = createSupabaseBrowserClient;
