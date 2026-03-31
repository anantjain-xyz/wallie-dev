import type { Database } from "@/lib/supabase/database.types";

export type AppDatabase = Database;

export type SupabaseCookieValue = {
  name: string;
  value: string;
};
