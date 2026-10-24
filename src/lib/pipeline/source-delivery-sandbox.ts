import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createUtilitySandbox, stopSandboxById } from "@/lib/sandbox";
import type { SandboxHandle } from "@/lib/sandbox/types";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import {
  recordWorkspaceSandbox,
  reserveWorkspaceSandbox,
  settleWorkspaceResource,
  WorkspaceDeletingError,
} from "@/lib/workspaces/resource-operations";
import {
  restoreAndPushSourceWithWorkspace,
  type SourceRestoreInput,
} from "./source-delivery-git-core";

/** Utility sandboxes use the selected workspace provider, with no agent credentials. */
export async function restoreAndPushSourceInSandbox(
  input: SourceRestoreInput,
  context: {
    admin: SupabaseClient<Database>;
    workspaceId: string;
    runId: string;
  },
) {
  const { connection } = await loadRequiredWorkspaceSandboxConnection(
    context.admin,
    context.workspaceId,
  );
  let sandbox: SandboxHandle | undefined;
  return restoreAndPushSourceWithWorkspace(input, {
    execGit: async (args, options) => {
      if (!sandbox) throw new Error("Source utility sandbox is unavailable.");
      const command = await sandbox.exec("git", args, {
        cwd: options.cwd,
        env: Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeout)]),
      });
      const [output, code] = await Promise.all([command.output(), command.exitCode]);
      if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > options.maxBuffer)
        throw new Error("Git output exceeded its limit.");
      if (code !== 0) throw Object.assign(new Error("Source Git operation failed."), { code });
      return output;
    },
    createWorkspace: async () => {
      const operationId = await reserveWorkspaceSandbox(context.admin, {
        connection,
        provider: connection.provider,
        timeoutMs: 120_000,
        acquisitionTimeoutMs: 60_000,
        workspaceId: context.workspaceId,
      });
      let recorded = false;
      try {
        sandbox = await createUtilitySandbox(
          {
            workspaceId: context.workspaceId,
            ownerId: context.runId,
            timeoutMs: 120_000,
            signal: input.signal,
            onSandboxCreated: async ({ sandboxId }) => {
              const accepted = await recordWorkspaceSandbox(context.admin, operationId, sandboxId);
              recorded = true;
              if (!accepted) throw new WorkspaceDeletingError();
              // Once the provider ID is known, cleanup need not wait for the
              // conservative unknown-acquisition/provider-TTL recovery window.
              const renewal = await context.admin
                .from("workspace_resource_operations")
                .update({ recovery_after: new Date(Date.now() + 120_000).toISOString() })
                .eq("id", operationId);
              if (renewal.error) throw new Error("Could not record helper recovery deadline.");
            },
          },
          connection,
        );
        const handle = sandbox;
        const path = `/tmp/wallie-delivery-${randomUUID()}`;
        const close = async () => {
          try {
            await stopSandboxById(handle.id, { connection, throwOnError: true });
            await settleWorkspaceResource(context.admin, operationId, true);
          } catch {
            await settleWorkspaceResource(context.admin, operationId, false).catch(() => undefined);
            throw new Error("Source delivery sandbox cleanup will retry.");
          }
        };
        try {
          const command = await handle.exec("mkdir", ["-m", "700", path], {
            cwd: "/tmp",
            signal: input.signal,
          });
          if ((await command.exitCode) !== 0) throw new Error("Could not prepare source delivery.");
          return {
            path,
            writeBundle: (bytes: Buffer) =>
              handle.writeFile(`${path}/source.bundle`, bytes, { mode: 0o600 }),
            close,
          };
        } catch (error) {
          await close();
          throw error;
        }
      } catch {
        if (recorded)
          await settleWorkspaceResource(context.admin, operationId, false).catch(() => undefined);
        throw new Error("Could not provision source delivery sandbox.");
      }
    },
  });
}
