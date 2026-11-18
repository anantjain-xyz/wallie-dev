import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentProvider } from "@/lib/agent-config/contracts";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

export class ScopedRunCredentialUnavailableError extends Error {
  constructor() {
    super("An approved service principal credential binding is required to start this run.");
    this.name = "ScopedRunCredentialUnavailableError";
  }
}

/** Resolve and decrypt after nonsecret runner setup, directly before injection. */
export async function resolveScopedRunCredential(input: {
  admin: SupabaseClient<Database>;
  attemptCount: number;
  bindingId: string;
  jobId: string;
  provider: AgentProvider;
  runId: string;
  signal?: AbortSignal;
  workspaceId: string;
}): Promise<string> {
  input.signal?.throwIfAborted();
  try {
    const request = input.admin.rpc("resolve_factory_run_credential", {
      p_workspace_id: input.workspaceId,
      p_job_id: input.jobId,
      p_run_id: input.runId,
      p_attempt_count: input.attemptCount,
    });
    const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
    input.signal?.throwIfAborted();
    const row = data?.[0];
    if (error || row?.binding_id !== input.bindingId || row.agent_provider !== input.provider) {
      throw new ScopedRunCredentialUnavailableError();
    }
    const value = decryptSecretValue(row.encrypted_value);
    // Bindings deliver API keys; the existing source scanner recognizes secrets
    // of at least eight bytes and ignores shorter, ambiguous fragments.
    if (!/^[!-~]{8,}$/.test(value)) throw new ScopedRunCredentialUnavailableError();
    return value;
  } catch {
    input.signal?.throwIfAborted();
    // Database and decrypt exceptions must not escape with connection contents.
    throw new ScopedRunCredentialUnavailableError();
  }
}
