import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sessionAttachmentBucket } from "@/lib/storage/session-attachment";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

const CLEANUP_RETRY_MS = 60 * 60 * 1000;

export async function cleanupExpiredSessionAttachments(admin: AdminClient, maxCount = 100) {
  const { data: claimed, error: claimError } = await admin.rpc(
    "claim_expired_session_attachments",
    { max_count: maxCount },
  );

  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) {
    return { claimed: 0, deleted: 0, failed: 0 };
  }

  const ids = claimed.map((attachment) => attachment.id);
  const paths = claimed.map((attachment) => attachment.storage_path);
  const claimTimestamps = new Set(claimed.map((attachment) => attachment.delete_claimed_at));
  const deleteClaimedAt = claimed[0]?.delete_claimed_at;
  if (!deleteClaimedAt || claimTimestamps.size !== 1) {
    throw new Error("Attachment cleanup returned an invalid deletion lease.");
  }
  const { error: storageError } = await admin.storage.from(sessionAttachmentBucket).remove(paths);

  if (storageError) {
    await restoreClaimedAttachments(admin, ids, deleteClaimedAt);
    return { claimed: ids.length, deleted: 0, failed: ids.length };
  }

  const { error: deleteError } = await admin
    .from("session_attachments")
    .delete()
    .in("id", ids)
    .eq("status", "deleting")
    .eq("delete_claimed_at", deleteClaimedAt)
    .is("session_id", null);

  if (deleteError) {
    await restoreClaimedAttachments(admin, ids, deleteClaimedAt);
    return { claimed: ids.length, deleted: 0, failed: ids.length };
  }

  return { claimed: ids.length, deleted: ids.length, failed: 0 };
}

export async function removeWorkspaceSessionAttachments(
  admin: AdminClient,
  workspaceId: string,
  knownPaths: string[] = [],
) {
  const bucket = admin.storage.from(sessionAttachmentBucket);
  const paths = new Set(knownPaths);
  let offset = 0;

  while (true) {
    const { data, error } = await bucket.list(workspaceId, {
      limit: 100,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const object of data) paths.add(`${workspaceId}/${object.name}`);
    if (data.length < 100) break;
    offset += data.length;
  }

  const pathList = Array.from(paths);
  for (let index = 0; index < pathList.length; index += 100) {
    const { error } = await bucket.remove(pathList.slice(index, index + 100));
    if (error) throw error;
  }
}

async function restoreClaimedAttachments(
  admin: AdminClient,
  ids: string[],
  deleteClaimedAt: string,
) {
  const { error } = await admin
    .from("session_attachments")
    .update({
      delete_claimed_at: null,
      expires_at: new Date(Date.now() + CLEANUP_RETRY_MS).toISOString(),
      status: "ready",
    })
    .in("id", ids)
    .eq("status", "deleting")
    .eq("delete_claimed_at", deleteClaimedAt)
    .is("session_id", null);

  if (error) {
    console.error("[session-attachments] failed to restore cleanup claims", {
      attachmentIds: ids,
      error: error.message,
    });
  }
}
