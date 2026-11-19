import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { isMcpBearerToken, type FactoryMcpManifest } from "./manifest";

export class McpCredentialsUnavailableError extends Error {
  constructor() {
    super("The pinned MCP tool scopes or credentials are no longer authorized for this attempt.");
    this.name = "McpCredentialsUnavailableError";
  }
}

export async function resolveFactoryMcpCredentials({
  admin,
  workspaceId,
  jobId,
  runId,
  attemptCount,
  manifest,
  signal,
}: {
  admin: SupabaseClient<Database>;
  workspaceId: string;
  jobId: string;
  runId: string;
  attemptCount: number;
  manifest: FactoryMcpManifest;
  signal?: AbortSignal;
}): Promise<ReadonlyMap<string, string>> {
  const bindings = new Map(
    manifest.servers.flatMap(({ toolRevisionId, auth }) =>
      auth.kind === "bearer" ? [[toolRevisionId, auth.secretBindingId]] : [],
    ),
  );
  try {
    signal?.throwIfAborted();
    const request = admin.rpc("resolve_factory_run_mcp_credentials", {
      p_workspace_id: workspaceId,
      p_job_id: jobId,
      p_run_id: runId,
      p_attempt_count: attemptCount,
    });
    const { error, data } = await (signal ? request.abortSignal(signal) : request);
    signal?.throwIfAborted();
    if (error || !data || data.length !== bindings.size) throw new McpCredentialsUnavailableError();
    const seen = new Set<string>();
    for (const row of data) {
      if (bindings.get(row.tool_revision_id) !== row.binding_id || seen.has(row.tool_revision_id)) {
        throw new McpCredentialsUnavailableError();
      }
      seen.add(row.tool_revision_id);
    }
    return new Map(
      data.map((row) => {
        const token = decryptSecretValue(row.encrypted_value);
        if (!isMcpBearerToken(token)) throw new McpCredentialsUnavailableError();
        return [row.tool_revision_id, token];
      }),
    );
  } catch {
    signal?.throwIfAborted();
    throw new McpCredentialsUnavailableError();
  }
}
