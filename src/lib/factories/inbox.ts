import "server-only";

import {
  factoryInboxCursorSchema,
  factoryInboxProjectionSchema,
  type FactoryInbox,
  type FactoryInboxKind,
} from "./inbox-schema";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";

export class FactoryInboxCursorError extends Error {}

function parseCursor(cursor: string) {
  try {
    if (!/^[a-zA-Z0-9_-]{1,180}$/.test(cursor)) throw new FactoryInboxCursorError();
    return factoryInboxCursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
  } catch {
    throw new FactoryInboxCursorError("Invalid Inbox cursor.");
  }
}

export async function loadFactoryInbox({
  supabase,
  workspaceId,
  factoryId,
  kind,
  cursor,
}: {
  supabase: WorkspaceAccessContext["supabase"];
  workspaceId: string;
  factoryId?: string | null;
  kind?: FactoryInboxKind;
  cursor?: string | null;
}): Promise<FactoryInbox | null> {
  const before = cursor == null ? null : parseCursor(cursor);
  const { data, error } = await supabase.rpc("get_factory_inbox", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId ?? undefined,
    p_before_at: before?.occurredAt,
    p_before_artifact_id: before?.artifactId,
    ...(kind && { p_kind: kind }),
  });
  if (error) throw error;
  if (data === null) return null;

  const { items, counts, next } = factoryInboxProjectionSchema.parse(data);
  return {
    items,
    counts,
    nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null,
  };
}
