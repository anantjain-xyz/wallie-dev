import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { reconcileGitHubPrVerification } from "@/features/github/pr-verification-service";
import { reconcilePrReadiness } from "@/lib/pipeline/pr-readiness";
import { sweepStalledRuns } from "@/worker/stall-detector";
import { drainCanonicalPullRequests } from "@/lib/pipeline/canonical-pr-publisher";
import { cleanupExpiredSessionAttachments } from "@/lib/storage/session-attachment-cleanup";
import { cleanupRunExports, drainRunExports } from "@/lib/run-exports/worker";
import { drainRunRetention } from "@/lib/run-retention/maintenance";
import { pruneFactoryOAuthCredentials } from "@/lib/factory-oauth/maintenance";
import type { Env } from "../index";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/features/github/pr-verification-service", () => ({
  reconcileGitHubPrVerification: vi.fn(),
}));
vi.mock("@/lib/pipeline/pr-readiness", () => ({ reconcilePrReadiness: vi.fn() }));
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
vi.mock("@/lib/run-retention/maintenance", () => ({ drainRunRetention: vi.fn() }));
vi.mock("@/lib/factory-oauth/maintenance", () => ({ pruneFactoryOAuthCredentials: vi.fn() }));
vi.mock("@/lib/workspaces/deletion", () => ({ resumePendingWorkspaceDeletions: vi.fn() }));
vi.mock("@/lib/run-exports/worker", () => ({
  cleanupRunExports: vi.fn(),
  drainRunExports: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, true],
])(
  "runs verification, readiness and independent cleanup (GitHub fails=%s, readiness fails=%s, OAuth cleanup fails=%s)",
  async (githubFailure, readinessFailure, oauthCleanupFailure) => {
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
    if (githubFailure)
      vi.mocked(reconcileGitHubPrVerification).mockRejectedValue(
        new Error("temporarily unavailable"),
      );
    else
      vi.mocked(reconcileGitHubPrVerification).mockResolvedValue({
        checked: 1,
        refreshed: 1,
        failed: 0,
      });
    if (readinessFailure)
      vi.mocked(reconcilePrReadiness).mockRejectedValue(new Error("temporarily unavailable"));
    else
      vi.mocked(reconcilePrReadiness).mockResolvedValue({
        evaluated: 1,
        recorded: 1,
        failed: 0,
      });
    if (oauthCleanupFailure)
      vi.mocked(pruneFactoryOAuthCredentials).mockRejectedValue(
        new Error("temporarily unavailable"),
      );
    const inspection = await introspectWorkflowInstance(bindings.MAINTENANCE, id);
    try {
      await bindings.MAINTENANCE.create({ id, params: { tick: Date.now() } });
      await inspection.waitForStatus("complete");
      expect(reconcileGitHubPrVerification).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainCanonicalPullRequests).toHaveBeenCalledExactlyOnceWith(admin);
      expect(vi.mocked(drainCanonicalPullRequests).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(reconcileGitHubPrVerification).mock.invocationCallOrder[0],
      );
      expect(reconcilePrReadiness).toHaveBeenCalledExactlyOnceWith(admin);
      expect(vi.mocked(reconcileGitHubPrVerification).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(reconcilePrReadiness).mock.invocationCallOrder[0],
      );
      expect(sweepStalledRuns).toHaveBeenCalledExactlyOnceWith(admin, 900_000);
      expect(vi.mocked(reconcilePrReadiness).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(sweepStalledRuns).mock.invocationCallOrder[0],
      );
      expect(cleanupExpiredSessionAttachments).toHaveBeenCalledExactlyOnceWith(admin);
      expect(drainRunRetention).toHaveBeenCalledExactlyOnceWith(admin);
      expect(pruneFactoryOAuthCredentials).toHaveBeenCalledExactlyOnceWith(admin);
      expect(vi.mocked(sweepStalledRuns).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(cleanupExpiredSessionAttachments).mock.invocationCallOrder[0],
      );
      expect(drainRunExports).toHaveBeenCalledExactlyOnceWith(admin);
      expect(cleanupRunExports).toHaveBeenCalledExactlyOnceWith(admin);
    } finally {
      await inspection.dispose();
    }
  },
);
