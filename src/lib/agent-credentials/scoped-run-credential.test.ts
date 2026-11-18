import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { resolveScopedRunCredential } from "./scoped-run-credential";

const fixtureCredential = "synthetic-scoped-provider-key-1234";
const fixtureInput = {
  workspaceId: "workspace-fixture",
  jobId: "job-fixture",
  runId: "run-fixture",
  attemptCount: 2,
  bindingId: "binding-fixture",
  provider: "claude-code" as const,
};

afterEach(() => vi.unstubAllEnvs());

describe("resolveScopedRunCredential", () => {
  it("decrypts the authorized binding after invoking the exact attempt RPC", async () => {
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "local-encryption-fixture-key");
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          binding_id: fixtureInput.bindingId,
          agent_provider: fixtureInput.provider,
          encrypted_value: encryptSecretValue(fixtureCredential),
        },
      ],
      error: null,
    });
    const admin = { rpc } as unknown as SupabaseClient<Database>;

    await expect(resolveScopedRunCredential({ ...fixtureInput, admin })).resolves.toBe(
      fixtureCredential,
    );
    expect(rpc).toHaveBeenCalledExactlyOnceWith("resolve_factory_run_credential", {
      p_workspace_id: fixtureInput.workspaceId,
      p_job_id: fixtureInput.jobId,
      p_run_id: fixtureInput.runId,
      p_attempt_count: fixtureInput.attemptCount,
    });
  });

  it.each([
    { data: null, error: { message: `database denied ${fixtureCredential}` } },
    {
      data: [
        {
          binding_id: "different-binding",
          agent_provider: fixtureInput.provider,
          encrypted_value: fixtureCredential,
        },
      ],
      error: null,
    },
    {
      data: [
        {
          binding_id: fixtureInput.bindingId,
          agent_provider: "codex",
          encrypted_value: fixtureCredential,
        },
      ],
      error: null,
    },
    {
      data: [
        {
          binding_id: fixtureInput.bindingId,
          agent_provider: fixtureInput.provider,
          encrypted_value: fixtureCredential,
        },
      ],
      error: null,
    },
  ])("fails closed without forwarding RPC or credential material (%#)", async (response) => {
    const rpc = vi.fn().mockResolvedValue(response);
    const admin = { rpc } as unknown as SupabaseClient<Database>;

    await expect(resolveScopedRunCredential({ ...fixtureInput, admin })).rejects.toMatchObject({
      name: "ScopedRunCredentialUnavailableError",
      message: "An approved service principal credential binding is required to start this run.",
    });
    expect(rpc).toHaveBeenCalledOnce();
  });
});
