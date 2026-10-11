import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { stopSandboxById } from "@/lib/sandbox";
import { loadWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import type { SandboxProvider } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";
import { stopWorkspaceProviderSandboxes } from "@/lib/vercel-sandbox/teardown";

type AdminClient = SupabaseClient<Database>;

/** Delete the first page repeatedly, so removals cannot shift unseen objects. */
export async function removeWorkspaceStoragePrefix(
  admin: AdminClient,
  bucketName: string,
  prefix: string,
): Promise<void> {
  const bucket = admin.storage.from(bucketName);
  while (true) {
    const { data, error } = await bucket.list(prefix, {
      limit: 100,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    if (!data?.length) return;
    const objects: string[] = [];
    for (const object of data) {
      const path = `${prefix}/${object.name}`;
      if (object.id === null) await removeWorkspaceStoragePrefix(admin, bucketName, path);
      else objects.push(path);
    }
    if (objects.length) {
      const { error: removeError } = await bucket.remove(objects);
      if (removeError) throw removeError;
    }
  }
}

async function cleanupResourceReservations(
  admin: AdminClient,
  workspaceId: string,
  recoverOnly = false,
) {
  let pending = false;
  let afterId: string | null = null;
  while (true) {
    let query = admin
      .from("workspace_resource_operations")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("id")
      .limit(100);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    for (const operation of data) {
      const recoveryDue = Date.parse(operation.recovery_after) <= Date.now();
      if (recoverOnly && !operation.settled_at && !recoveryDue) continue;
      if (operation.kind === "sandbox" && operation.resource_id) {
        const connection =
          operation.provider === "fake"
            ? null
            : await loadWorkspaceSandboxConnection(
                admin,
                workspaceId,
                operation.provider as SandboxProvider,
              );
        if (operation.provider !== "fake" && !connection) {
          throw new Error("Workspace sandbox cleanup credentials are unavailable.");
        }
        if (
          operation.connection_revision &&
          operation.connection_revision !== connection?.connection.revision
        ) {
          throw new Error("Workspace sandbox cleanup connection changed.");
        }
        await stopSandboxById(operation.resource_id, {
          connection: connection?.connection,
          throwOnError: true,
        });
      } else if (!operation.settled_at && !recoveryDue) {
        // A creator may still publish a sandbox ID or finish an upload. Keep
        // the workspace, provider credentials, and prefix until it settles.
        pending = true;
        continue;
      }
      if (operation.kind === "upload" && operation.resource_id && operation.storage_bucket) {
        const { error: removeError } = await admin.storage
          .from(operation.storage_bucket)
          .remove([operation.resource_id]);
        if (removeError) throw removeError;
      }
      let removal = admin.from("workspace_resource_operations").delete().eq("id", operation.id);
      // A late acquired ID must survive a cleanup based on an earlier NULL ID.
      removal =
        operation.resource_id === null
          ? removal.is("resource_id", null)
          : removal.eq("resource_id", operation.resource_id);
      const { error: removeError } = await removal;
      if (removeError) throw removeError;
    }
    afterId = data[data.length - 1]!.id;
    if (data.length < 100) break;
  }
  return !pending;
}

/** Retry-safe: the fence and all cleanup owners survive any thrown error. */
export async function resumeWorkspaceDeletion(admin: AdminClient, workspaceId: string) {
  const { data: workspace, error } = await admin
    .from("workspaces")
    .select("deletion_requested_at")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!workspace) return true;
  if (!workspace.deletion_requested_at) return false;

  await stopWorkspaceProviderSandboxes(admin, workspaceId);
  if (!(await cleanupResourceReservations(admin, workspaceId))) return false;
  await removeWorkspaceStoragePrefix(admin, "workspace-avatars", workspaceId);
  await removeWorkspaceStoragePrefix(admin, "session-attachments", workspaceId);
  const { data: deleted, error: finishError } = await admin.rpc("finish_workspace_deletion", {
    p_workspace_id: workspaceId,
  });
  if (finishError) throw finishError;
  return deleted;
}

export async function resumePendingWorkspaceDeletions(admin: AdminClient) {
  // Failed acquisitions also retain cleanup ownership in active workspaces.
  // Reconcile those first so their credentials can eventually be rotated.
  let afterOperationId: string | null = null;
  const recoveredWorkspaces = new Set<string>();
  while (true) {
    let query = admin
      .from("workspace_resource_operations")
      .select("id, workspace_id")
      .or(`settled_at.not.is.null,recovery_after.lte.${new Date().toISOString()}`)
      .order("id")
      .limit(100);
    if (afterOperationId) query = query.gt("id", afterOperationId);
    const { data: abandoned, error: abandonedError } = await query;
    if (abandonedError) throw abandonedError;
    if (!abandoned?.length) break;
    for (const operation of abandoned) {
      if (recoveredWorkspaces.has(operation.workspace_id)) continue;
      recoveredWorkspaces.add(operation.workspace_id);
      try {
        await cleanupResourceReservations(admin, operation.workspace_id, true);
      } catch (error) {
        console.error("[workspace-delete] resource recovery will retry", {
          error: error instanceof Error ? error.message : String(error),
          workspaceId: operation.workspace_id,
        });
      }
    }
    afterOperationId = abandoned[abandoned.length - 1]!.id;
    if (abandoned.length < 100) break;
  }
  let afterId: string | null = null;
  let deleted = 0;
  let pending = 0;
  while (true) {
    let query = admin
      .from("workspaces")
      .select("id")
      .not("deletion_requested_at", "is", null)
      .order("id")
      .limit(100);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    for (const workspace of data) {
      try {
        if (await resumeWorkspaceDeletion(admin, workspace.id)) deleted++;
        else pending++;
      } catch (error) {
        pending++;
        console.error("[workspace-delete] cleanup will retry", {
          error: error instanceof Error ? error.message : String(error),
          workspaceId: workspace.id,
        });
      }
    }
    afterId = data[data.length - 1]!.id;
    if (data.length < 100) break;
  }
  return { deleted, pending };
}
