import type { Tables } from "@/lib/supabase/database.types";

/**
 * Credential RPCs use this context to join active human membership and the
 * encrypted credential in one statement. Never resolve an owner first and
 * use that cached identity for a second, unscoped credential query.
 */
export type SessionCredentialOwner = Pick<Tables<"sessions">, "creator_member_id" | "workspace_id">;
