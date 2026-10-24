import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSessionSandbox } from "@/lib/sandbox";
import { getSandboxProviderContract } from "@/lib/sandbox/provider-contract";
import type {
  CreateSessionSandboxInput,
  SandboxImplementation,
  SandboxConnection,
} from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export class WorkspaceDeletingError extends Error {
  constructor() {
    super("Workspace deletion is in progress.");
    this.name = "WorkspaceDeletingError";
  }
}

/** Reserve before remote I/O; even a process crash leaves a deletion obligation. */
export async function reserveWorkspaceSandbox(
  admin: AdminClient,
  input: {
    connection?: SandboxConnection;
    provider: SandboxImplementation;
    timeoutMs?: number;
    acquisitionTimeoutMs?: number;
    workspaceId: string;
  },
) {
  const acquisitionMs = Math.min(
    input.acquisitionTimeoutMs ?? Infinity,
    input.provider === "fake"
      ? 60_000
      : getSandboxProviderContract(input.provider).deadlines.acquire,
  );
  // With no returned provider ID, retain credentials through acquisition plus
  // the sandbox's provider-enforced lifetime (including Daytona's 10m buffer).
  const recoveryMs = acquisitionMs + (input.timeoutMs ?? 30 * 60_000) + 10 * 60_000;
  const { data, error } = await admin.rpc("begin_workspace_resource_operation", {
    ...(input.connection ? { p_connection_revision: input.connection.revision } : {}),
    p_kind: "sandbox",
    p_provider: input.provider,
    p_recovery_after: new Date(Date.now() + recoveryMs).toISOString(),
    p_resource_id: "",
    p_storage_bucket: "",
    p_workspace_id: input.workspaceId,
  });
  if (error) throw error;
  if (!data) throw new WorkspaceDeletingError();
  return data;
}

export async function recordWorkspaceSandbox(
  admin: AdminClient,
  operationId: string,
  sandboxId: string,
) {
  const { data, error } = await admin.rpc("record_workspace_resource_operation", {
    p_operation_id: operationId,
    p_resource_id: sandboxId,
  });
  if (error) throw error;
  return data;
}

export async function settleWorkspaceResource(
  admin: AdminClient,
  operationId: string,
  transferred: boolean,
) {
  const { error } = await admin.rpc("settle_workspace_resource_operation", {
    p_operation_id: operationId,
    p_transferred: transferred,
  });
  if (error) throw error;
}

export async function createWorkspaceSessionSandbox(
  admin: AdminClient,
  input: CreateSessionSandboxInput & {
    onSandboxCreated: NonNullable<CreateSessionSandboxInput["onSandboxCreated"]>;
    workspaceId: string;
  },
) {
  const operationId = await reserveWorkspaceSandbox(admin, {
    connection: input.connection,
    provider: input.implementation === "fake" ? "fake" : (input.connection?.provider ?? "fake"),
    timeoutMs: input.timeoutMs,
    workspaceId: input.workspaceId,
  });
  let recorded = false;
  try {
    const sandbox = await createSessionSandbox({
      ...input,
      onSandboxCreated: async (metadata) => {
        // Record before the run/check CAS: cancellation must not erase the ID
        // needed by deletion cleanup if acquisition's best-effort stop fails.
        const accepted = await recordWorkspaceSandbox(admin, operationId, metadata.sandboxId);
        recorded = true;
        if (!accepted) throw new WorkspaceDeletingError();
        await input.onSandboxCreated(metadata);
      },
    });
    await settleWorkspaceResource(admin, operationId, true);
    return sandbox;
  } catch (error) {
    if (recorded) {
      await settleWorkspaceResource(admin, operationId, false).catch(() => undefined);
    }
    // An unknown remote outcome remains reserved until its recovery deadline.
    throw error;
  }
}

export async function uploadWorkspaceObject(
  admin: AdminClient,
  input: {
    bucket: "workspace-avatars" | "session-attachments" | "session-source-checkpoints";
    bytes: Buffer;
    contentType: string;
    path: string;
    workspaceId: string;
  },
) {
  const { data: operationId, error } = await admin.rpc("begin_workspace_resource_operation", {
    p_kind: "upload",
    p_provider: "",
    p_recovery_after: new Date(Date.now() + 5 * 60_000).toISOString(),
    p_resource_id: input.path,
    p_storage_bucket: input.bucket,
    p_workspace_id: input.workspaceId,
  });
  if (error) throw error;
  if (!operationId) throw new WorkspaceDeletingError();
  const result = await admin.storage.from(input.bucket).upload(input.path, input.bytes, {
    cacheControl: "3600",
    contentType: input.contentType,
    upsert: false,
  });
  if (!result.error) {
    // Storage metadata owns the object now; its final write also has a DB
    // admission fence, so a delayed upload cannot recreate a deleted prefix.
    await settleWorkspaceResource(admin, operationId, true);
  }
  return result;
}
