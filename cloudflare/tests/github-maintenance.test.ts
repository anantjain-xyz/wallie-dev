import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { reconcileGitHubPrVerification } from "@/features/github/pr-verification-service";
import { drainCanonicalPullRequests } from "@/lib/pipeline/canonical-pr-publisher";
import { cleanupExpiredSessionAttachments } from "@/lib/storage/session-attachment-cleanup";
import type { Env } from "../index";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/features/github/pr-verification-service", () => ({
  reconcileGitHubPrVerification: vi.fn(),
}));
vi.mock("@/lib/pipeline/canonical-pr-publisher", () => ({ drainCanonicalPullRequests: vi.fn() }));
vi.mock("@/lib/pipeline/checkpoint-publication", () => ({ drainCheckpointPublications: vi.fn() }));
vi.mock("@/lib/pipeline/source-delivery", () => ({ drainSourceDeliveries: vi.fn() }));
vi.mock("@/lib/pipeline/checkpoint-cleanup", () => ({ drainCheckpointCleanup: vi.fn() }));
vi.mock("@/worker/stall-detector", () => ({ sweepStalledRuns: vi.fn() }));
vi.mock("@/worker/reconciler", () => ({ reconcileLinearState: vi.fn() }));
vi.mock("@/worker/sandbox-reaper", () => ({ reapOrphanSandboxes: vi.fn() }));
vi.mock("@/lib/storage/session-attachment-cleanup", () => ({
  cleanupExpiredSessionAttachments: vi.fn(),
}));
vi.mock("@/lib/workspaces/deletion", () => ({ resumePendingWorkspaceDeletions: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

it.each([false, true])(
  "runs bounded GitHub reconciliation in native maintenance and preserves later cleanup after failure=%s",
  async (failure) => {
    const bindings = env as unknown as Env;
    const id = `maintenance-${crypto.randomUUID()}`;
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      in: () => query,
      then(resolve: (value: { data: never[]; count: number; error: null }) => unknown) {
        return Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
      },
    };
    const admin = { from: () => query };
    vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as never);
    if (failure)
      vi.mocked(reconcileGitHubPrVerification).mockRejectedValue(
        new Error("temporarily unavailable"),
      );
    else
      vi.mocked(reconcileGitHubPrVerification).mockResolvedValue({
        checked: 1,
        refreshed: 1,
        failed: 0,
      });
    const inspection = await introspectWorkflowInstance(bindings.MAINTENANCE, id);
    try {
      await bindings.MAINTENANCE.create({ id, params: { tick: Date.now() } });
      await inspection.waitForStatus("complete");
      expect(reconcileGitHubPrVerification).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainCanonicalPullRequests).toHaveBeenCalledExactlyOnceWith(admin);
      expect(vi.mocked(drainCanonicalPullRequests).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(reconcileGitHubPrVerification).mock.invocationCallOrder[0],
      );
      expect(cleanupExpiredSessionAttachments).toHaveBeenCalledExactlyOnceWith(admin);
    } finally {
      await inspection.dispose();
    }
  },
);
