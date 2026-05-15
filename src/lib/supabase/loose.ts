import type { SupabaseClient } from "@supabase/supabase-js";

type LooseRow = Record<string, unknown>;

type LooseTable = {
  Insert: LooseRow;
  Relationships: [];
  Row: LooseRow;
  Update: LooseRow;
};

type LooseDatabase = {
  public: {
    CompositeTypes: Record<string, never>;
    Enums: Record<string, string>;
    Functions: Record<string, never>;
    Tables: Record<string, LooseTable>;
    Views: Record<string, never>;
  };
};

export type LooseSupabaseClient = SupabaseClient<LooseDatabase>;

/**
 * Temporary adapter for tables introduced by local migrations before the
 * generated Supabase bindings are refreshed. Keep callers narrow and explicit;
 * the migration remains the source of truth for these tables.
 */
export function asLooseSupabaseClient(client: unknown): LooseSupabaseClient {
  return client as LooseSupabaseClient;
}
