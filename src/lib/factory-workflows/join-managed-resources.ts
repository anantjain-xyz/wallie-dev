import "server-only";

import { z } from "zod";
import { createUtilitySandbox, stopSandboxById } from "@/lib/sandbox";
import type { SandboxConnection, SandboxHandle } from "@/lib/sandbox/types";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import {
  recordWorkspaceSandbox,
  reserveWorkspaceSandbox,
  settleWorkspaceResource,
} from "@/lib/workspaces/resource-operations";
import { conflictBucket } from "./join-conflict";
import type { Context, ManagedResources } from "./join-worker-runtime";

function exactAttempt({ claim }: Context) {
  return {
    p_root_session_id: claim.rootSessionId,
    p_workspace_id: claim.workspaceId,
    p_factory_id: claim.factoryId,
    p_expected_generation: claim.generation,
    p_ownership_token: claim.ownershipToken,
    p_join_id: claim.joinId,
    p_job_id: claim.jobId,
    p_run_id: claim.runId,
    p_attempt_count: claim.attemptCount,
  };
}

async function assertActive(context: Context) {
  context.signal.throwIfAborted();
  const { data, error } = await context.admin
    .rpc("is_factory_workflow_join_attempt_active", exactAttempt(context))
    .abortSignal(context.signal);
  if (error || data !== true)
    throw new Error("The exact workflow join no longer owns the attempt.");
}

async function attachForValidation(
  { admin, claim, signal }: Context,
  connection: SandboxConnection,
  sandboxId: string,
) {
  const result = await admin
    .from("agent_runs")
    .update({
      sandbox_id: sandboxId,
      sandbox_provider: connection.provider,
      sandbox_connection_revision: connection.revision,
      sandbox_vercel_project_id:
        connection.provider === "vercel" ? connection.credentials.projectId : null,
      sandbox_vercel_team_id:
        connection.provider === "vercel" ? connection.credentials.teamId : null,
    })
    .eq("id", claim.runId)
    .eq("agent_job_id", claim.jobId)
    .eq("attempt_count", claim.attemptCount)
    .eq("workspace_id", claim.workspaceId)
    .eq("session_id", claim.parentSessionId)
    .in("status", ["started", "running"])
    .is("sandbox_id", null)
    .select("id")
    .abortSignal(signal)
    .maybeSingle();
  if (result.error || !result.data)
    throw new Error("The validation sandbox lost the exact workflow join attempt.");
}

async function stopReservedSandbox(
  { admin }: Context,
  connection: SandboxConnection,
  operationId: string,
  sandboxId: string,
) {
  try {
    await stopSandboxById(sandboxId, { connection, throwOnError: true });
    const recorded = await admin.rpc("record_workspace_sandbox_acquisition_stop", {
      p_operation_id: operationId,
      p_sandbox_id: sandboxId,
    });
    if (recorded.error || !recorded.data) throw new Error("Sandbox stop receipt is unavailable.");
    const settled = await admin.rpc("settle_factory_workflow_sandbox_acquisition", {
      p_operation_id: operationId,
      p_stopped_sandbox_ids: [sandboxId],
    });
    if (settled.error || !settled.data) throw new Error("Sandbox acquisition stop is unconfirmed.");
    await settleWorkspaceResource(admin, operationId, true);
  } catch {
    // The provider returned a handle. Keep the exact operation visible to the
    // workspace reaper even when the worker's own attempt has timed out.
    const storedId = await recordWorkspaceSandbox(admin, operationId, sandboxId).catch(() => false);
    if (storedId) await settleWorkspaceResource(admin, operationId, false).catch(() => undefined);
    throw new Error("Workflow join sandbox cleanup will retry.");
  }
}

async function withReservedUtility<T>(
  context: Context,
  mode: "integrate" | "validate",
  work: (sandbox: SandboxHandle) => Promise<T>,
): Promise<T> {
  const { admin, claim, signal } = context;
  await assertActive(context);
  const { connection } = await loadRequiredWorkspaceSandboxConnection(admin, claim.workspaceId);
  const remainingMs = Date.parse(context.deadlineAt) - Date.now();
  if (remainingMs <= 0) throw new Error("Workflow join deadline elapsed.");
  const timeoutMs = Math.min(remainingMs, mode === "integrate" ? 120_000 : 1_800_000);
  const operationId = await reserveWorkspaceSandbox(admin, {
    workspaceId: claim.workspaceId,
    connection,
    provider: connection.provider,
    acquisitionTimeoutMs: 60_000,
    timeoutMs,
  });

  let requested = false;
  let knownId: string | undefined;
  let handle: SandboxHandle | undefined;
  try {
    if (mode === "validate") {
      const attempt = await admin
        .rpc("register_factory_workflow_sandbox_acquisition", {
          p_run_id: claim.runId,
          p_attempt_count: claim.attemptCount,
          p_operation_id: operationId,
        })
        .abortSignal(signal);
      if (attempt.error || !attempt.data)
        throw new Error("The join validation acquisition lost its attempt.");
    }
    await assertActive(context);
    requested = true;
    handle = await createUtilitySandbox(
      {
        workspaceId: claim.workspaceId,
        ownerId: claim.runId,
        timeoutMs,
        signal,
        acquisition: { operationId, workspaceId: claim.workspaceId },
        onSandboxCreated: async ({ provider, sandboxId }) => {
          knownId = sandboxId;
          // Make the ID durable before checking pause/deletion again.
          const accepted = await recordWorkspaceSandbox(admin, operationId, sandboxId);
          if (!accepted || provider !== connection.provider)
            throw new Error("The workflow join sandbox was no longer admitted.");
          await assertActive(context);
          if (mode === "validate") await attachForValidation(context, connection, sandboxId);
        },
      },
      connection,
    );
    const prepared = await handle.exec("mkdir", ["-p", "-m", "700", "--", handle.repoPath], {
      cwd: "/tmp",
      signal,
    });
    if ((await prepared.exitCode) !== 0)
      throw new Error("The workflow join workspace could not be prepared.");
    await assertActive(context);
    return await work(handle);
  } finally {
    try {
      if (knownId) await stopReservedSandbox(context, connection, operationId, knownId);
      if (!requested) await settleWorkspaceResource(admin, operationId, true);
      // A requested creation with no returned ID stays reserved until the
      // exact provider acquisition can be located by its reservation labels.
    } finally {
      await handle?.[Symbol.asyncDispose]?.();
    }
  }
}

const digest = z.string().regex(/^[0-9a-f]{64}$/);

export const joinManagedResources: ManagedResources = {
  integrate: (context, work) => withReservedUtility(context, "integrate", work),
  validate: (context, work) => withReservedUtility(context, "validate", work),
  conflicts: (context) => ({
    async upload(path, bytes, signal) {
      const { claim, admin } = context;
      const expectedPrefix =
        [claim.workspaceId, claim.rootSessionId, claim.joinId, claim.runId].join("/") + "/";
      const parsed = digest.safeParse(path.slice(expectedPrefix.length, -5));
      if (!path.startsWith(expectedPrefix) || !path.endsWith(".json") || !parsed.success)
        throw new Error("The workflow join report path does not match the attempt.");
      const reservation = await admin
        .rpc("reserve_factory_workflow_join_conflict", {
          ...exactAttempt(context),
          p_digest: parsed.data,
        })
        .abortSignal(signal);
      if (reservation.error || !reservation.data)
        throw new Error("The workflow join report upload was not reserved.");
      signal.throwIfAborted();
      const { error } = await admin.storage.from(conflictBucket).upload(path, bytes, {
        contentType: "application/json",
        cacheControl: "0",
        upsert: false,
      });
      if (error) throw new Error("The workflow join report upload is uncertain.");
    },
    async download(path, signal) {
      // A downlink checks bytes after an uncertain write. Only the SQL
      // settlement transfers the reservation to the immutable blocker.
      const { data, error } = await context.admin.storage
        .from(conflictBucket)
        .download(path, {}, { signal });
      signal.throwIfAborted();
      return error ? null : data;
    },
  }),
};
