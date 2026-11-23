import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/lib/supabase/database.types";
import { conflictBucket, readJoinConflict } from "./join-conflict";

type AdminClient = SupabaseClient<Database>;
const uuid = z.string().uuid();
const scopeSchema = z.strictObject({
  workspaceId: uuid,
  rootSessionId: uuid,
  joinId: uuid,
  runId: uuid,
});
const digest = z.string().regex(/^[0-9a-f]{64}$/);

export async function readAuthorizedJoinConflict(input: {
  user: Pick<AdminClient, "rpc">;
  storage: Pick<AdminClient, "storage">;
  scope: z.input<typeof scopeSchema>;
  signal: AbortSignal;
}) {
  const scope = scopeSchema.parse(input.scope);
  const { signal } = input;
  signal.throwIfAborted();
  // Use the signed-in user's client. The only datum from this RPC is the
  // server-selected digest for this exact parent/root/run, after RLS checks.
  const { data, error } = await input.user
    .rpc("read_factory_workflow_join_conflict_digest", {
      p_workspace_id: scope.workspaceId,
      p_root_session_id: scope.rootSessionId,
      p_join_id: scope.joinId,
      p_run_id: scope.runId,
    })
    .abortSignal(signal);
  if (error) throw new Error("The workflow join conflict is unavailable.");
  if (data === null) return null;
  return readJoinConflict(
    {
      async download(path) {
        const result = await input.storage.storage
          .from(conflictBucket)
          .download(path, {}, { signal });
        return result.error ? null : result.data;
      },
    },
    scope,
    digest.parse(data),
    signal,
  );
}
