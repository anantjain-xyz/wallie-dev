import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { runClaimedJob } from "@/worker/loop";
import { registerWorker, sendHeartbeat, deregisterWorker } from "@/worker/heartbeat";
import { processClaimedCursorAuthFlow } from "@/lib/cursor/auth-processor";
import type { Env } from "../index";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/worker/loop", () => ({ runClaimedJob: vi.fn() }));
vi.mock("@/worker/heartbeat", () => ({
  registerWorker: vi.fn(),
  sendHeartbeat: vi.fn(),
  deregisterWorker: vi.fn(),
}));
vi.mock("@/lib/cursor/auth-processor", () => ({ processClaimedCursorAuthFlow: vi.fn() }));

const bindings = env as unknown as Env;

function fixture() {
  const id = `job-${crypto.randomUUID()}-2`;
  const job = { id: "job", attempt_count: 2, status: "running", workspace_id: "workspace" };
  const run = {
    id: "run",
    status: "running",
    source_recovery_required: false,
    workspace_id: "workspace",
  };
  let executed = false;
  const rpc = vi.fn(async (name: string) => {
    if (name === "begin_worker_dispatch") {
      const data = !executed;
      executed = true;
      return { data, error: null };
    }
    return { data: "error", error: null };
  });
  const from = (table: string) => {
    const query = {
      select: () => query,
      eq: () => query,
      single: async () => ({
        data:
          table === "worker_dispatches"
            ? { deadline_at: new Date(Date.now() + 60_000).toISOString() }
            : job,
        error: null,
      }),
      maybeSingle: async () => ({
        data: table === "agent_runs" ? run : { value_json: 3 },
        error: null,
      }),
    };
    return query;
  };
  const admin = { from, rpc };
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as never);
  vi.mocked(runClaimedJob).mockResolvedValue(undefined);
  vi.mocked(registerWorker).mockResolvedValue(undefined);
  vi.mocked(sendHeartbeat).mockResolvedValue(undefined);
  vi.mocked(deregisterWorker).mockResolvedValue(undefined);
  return { id, job, run, admin, params: { jobId: "job", attemptCount: 2, workflowId: id } };
}

beforeEach(() => vi.resetAllMocks());

describe("native Workflow ownership", () => {
  it("executes a captured attempt once and fences an explicit Workflow replay", async () => {
    const f = fixture();
    const inspection = await introspectWorkflowInstance(bindings.SESSION_ATTEMPT, f.id);
    try {
      const instance = await bindings.SESSION_ATTEMPT.create({ id: f.id, params: f.params });
      await inspection.waitForStatus("complete");
      expect(runClaimedJob).toHaveBeenCalledExactlyOnceWith(f.admin, f.job, {
        timeoutMs: expect.any(Number),
        deadlineAt: expect.any(String),
      });
      expect(vi.mocked(runClaimedJob).mock.calls[0]![2]!.timeoutMs).toBeLessThanOrEqual(60_000);
      expect(sendHeartbeat).toHaveBeenCalledExactlyOnceWith(f.admin, `cloudflare-${f.id}`, ["job"]);
      expect(deregisterWorker).toHaveBeenCalledExactlyOnceWith(f.admin, `cloudflare-${f.id}`);
      f.run.status = "success";
      await instance.restart();
      await vi.waitFor(() =>
        expect(f.admin.rpc).toHaveBeenCalledWith("complete_session_job_attempt", {
          p_job_id: "job",
          p_attempt_count: 2,
          p_run_id: "run",
        }),
      );
      await inspection.waitForStatus("complete");
      expect(runClaimedJob).toHaveBeenCalledOnce();
      expect(registerWorker).toHaveBeenCalledOnce();
      expect(await inspection.getOutput()).toBeUndefined();
    } finally {
      await inspection.dispose();
    }
  });

  it("recovers interruption through the captured source guard without rerunning execution", async () => {
    const f = fixture();
    f.run.source_recovery_required = true;
    vi.mocked(runClaimedJob).mockRejectedValue(new Error("synthetic interruption"));
    const inspection = await introspectWorkflowInstance(bindings.SESSION_ATTEMPT, f.id);
    try {
      await bindings.SESSION_ATTEMPT.create({ id: f.id, params: f.params });
      await inspection.waitForStatus("complete");
      expect(runClaimedJob).toHaveBeenCalledOnce();
      expect(f.admin.rpc).toHaveBeenCalledWith("fail_session_job_attempt", {
        p_job_id: "job",
        p_attempt_count: 2,
        p_run_id: "run",
        p_error: "Cloudflare execution interrupted or reached its deadline.",
        p_retry: false,
        p_max_retries: 3,
      });
      expect(deregisterWorker).toHaveBeenCalledOnce();
    } finally {
      await inspection.dispose();
    }
  });

  it("rejects a mismatched instance identity before touching execution state", async () => {
    const f = fixture();
    const inspection = await introspectWorkflowInstance(bindings.SESSION_ATTEMPT, f.id);
    try {
      await bindings.SESSION_ATTEMPT.create({
        id: f.id,
        params: { ...f.params, workflowId: "other" },
      });
      await inspection.waitForStatus("errored");
      expect((await inspection.getError()).message).toContain("Workflow identity mismatch");
      expect(f.admin.rpc).not.toHaveBeenCalled();
      expect(runClaimedJob).not.toHaveBeenCalled();
    } finally {
      await inspection.dispose();
    }
  });

  it("processes a current Cursor claim once across Workflow replay", async () => {
    const id = `cursor-${crypto.randomUUID()}`;
    const flow = { id: "flow", expires_at: new Date(Date.now() + 60_000).toISOString() };
    let started = false;
    const from = (table: string) => {
      const query = {
        update: () => query,
        eq: () => query,
        is: () => query,
        select: () => query,
        in: () => query,
        gt: () => query,
        maybeSingle: async () => {
          if (table === "cursor_auth_flows") return { data: flow, error: null };
          const data = started ? null : { flow_id: "flow" };
          started = true;
          return { data, error: null };
        },
      };
      return query;
    };
    const admin = { from };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as never);
    vi.mocked(processClaimedCursorAuthFlow).mockResolvedValue(true);
    const inspection = await introspectWorkflowInstance(bindings.CURSOR_AUTH, id);
    try {
      const instance = await bindings.CURSOR_AUTH.create({
        id,
        params: { flowId: "flow", claimToken: "captured-claim", workflowId: id },
      });
      await inspection.waitForStatus("complete");
      await instance.restart();
      await inspection.waitForStatus("complete");
      expect(processClaimedCursorAuthFlow).toHaveBeenCalledExactlyOnceWith(
        admin,
        flow,
        "captured-claim",
      );
    } finally {
      await inspection.dispose();
    }
  });
});
