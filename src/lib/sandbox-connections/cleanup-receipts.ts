import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { stopSandboxById } from "@/lib/sandbox";
import type { SandboxConnection } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export async function hasSandboxCleanupReceipt(
  admin: AdminClient,
  owner: {
    connectionRevision: string | null;
    provider: string | null;
    sandboxId: string;
    workspaceId: string;
  },
) {
  if (!owner.connectionRevision || !owner.provider) return false;
  const { data, error } = await admin
    .from("workspace_sandbox_cleanup_receipts")
    .select("sandbox_id")
    .eq("workspace_id", owner.workspaceId)
    .eq("provider", owner.provider)
    .eq("connection_revision", owner.connectionRevision)
    .eq("sandbox_id", owner.sandboxId)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

/**
 * After active-work protection succeeds, but before replacing/discarding the
 * credentials, verify each recorded owner under the held connection-mutation
 * lease. A receipt survives later disconnection without erasing audit IDs.
 */
export async function confirmConnectionSandboxCleanup(input: {
  admin: AdminClient;
  connection: SandboxConnection;
  workspaceId: string;
}) {
  for (const table of [
    "agent_runs",
    "sandbox_capability_checks",
    "codex_device_auth_flows",
  ] as const) {
    let afterId: string | null = null;
    while (true) {
      let query = input.admin
        .from(table)
        .select("id, sandbox_id")
        .eq("workspace_id", input.workspaceId)
        .eq("sandbox_provider", input.connection.provider)
        .eq("sandbox_connection_revision", input.connection.revision)
        .not("sandbox_id", "is", null)
        .order("id")
        .limit(100);
      if (afterId) query = query.gt("id", afterId);
      const { data, error } = await query;
      if (error) throw error;
      if (!data?.length) break;
      for (const row of data) {
        if (!row.sandbox_id || row.sandbox_id.startsWith("provisioning:")) continue;
        const owner = {
          connectionRevision: input.connection.revision,
          provider: input.connection.provider,
          sandboxId: row.sandbox_id,
          workspaceId: input.workspaceId,
        };
        if (await hasSandboxCleanupReceipt(input.admin, owner)) continue;
        await stopSandboxById(row.sandbox_id, { connection: input.connection, throwOnError: true });
        const { error: receiptError } = await input.admin
          .from("workspace_sandbox_cleanup_receipts")
          .upsert({
            workspace_id: input.workspaceId,
            provider: input.connection.provider,
            connection_revision: input.connection.revision,
            sandbox_id: row.sandbox_id,
          });
        if (receiptError) throw receiptError;
      }
      afterId = data[data.length - 1]!.id;
      if (data.length < 100) break;
    }
  }
}
