import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

import type { FactoryImprovementValidationReceipt } from "@/lib/factory-proposals/validation-contracts";
import { readFactoryImprovementValidation } from "@/lib/factory-proposals/validation-server";

import { ImprovementQualification } from "./improvement-qualification";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/lib/factory-proposals/validation-server", () => ({
  readFactoryImprovementValidation: vi.fn(),
}));
const read = vi.mocked(readFactoryImprovementValidation);

const comparison = {
  suiteRevisionId: "targeted-revision",
  experimentId: "targeted-experiment",
  scheduleState: "active",
  reasons: [],
  plannedPairs: 6,
  resolvedPairs: 6,
} satisfies Partial<FactoryImprovementValidationReceipt["targeted"]>;

function receipt(status: FactoryImprovementValidationReceipt["status"], pending = false) {
  return {
    status,
    reasons: status === "stale" ? ["stale_proposal"] : [],
    targeted: {
      ...comparison,
      reasons: pending ? ["pending_work"] : [],
      resolvedPairs: pending ? 2 : 6,
    },
    holdout: {
      ...comparison,
      suiteRevisionId: "held-out-revision",
      experimentId: "held-out-experiment",
    },
  } as FactoryImprovementValidationReceipt;
}

async function qualification(canManage = true) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({
      data: [
        { id: "targeted-revision", suite_id: "targeted-suite" },
        { id: "held-out-revision", suite_id: "held-out-suite" },
      ],
    }),
  };
  const scope = {
    factory: { canManage },
    factoryId: "fixture-factory",
    workspaceId: "fixture-workspace",
    actorUserId: "fixture-actor",
    supabase: { from: vi.fn().mockReturnValue(query) },
  } as unknown as Parameters<typeof ImprovementQualification>[0]["scope"];
  const section = await ImprovementQualification({
    scope,
    workspaceSlug: "test",
    proposalId: "fixture-proposal",
    proposalRevisionId: "exact-revision",
  });
  return { html: renderToStaticMarkup(section), query };
}

beforeEach(() => read.mockReset());

it("shows qualification and both pinned comparisons without a publication", async () => {
  read.mockResolvedValue(receipt("qualified"));
  const { html, query } = await qualification();
  expect(read).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "fixture-workspace",
      factoryId: "fixture-factory",
      actorUserId: "fixture-actor",
      proposalId: "fixture-proposal",
      proposalRevisionId: "exact-revision",
    }),
  );
  expect(query.eq.mock.calls).toEqual([
    ["workspace_id", "fixture-workspace"],
    ["factory_id", "fixture-factory"],
  ]);
  expect(query.in).toHaveBeenCalledWith("id", ["targeted-revision", "held-out-revision"]);
  expect(html).toContain("Both benchmark comparisons met the recorded thresholds.");
  expect(html).toContain("/targeted-suite/comparisons/targeted-experiment?factory=fixture-factory");
  expect(html).toContain("/held-out-suite/comparisons/held-out-experiment?factory=fixture-factory");
  expect(html).toContain("of 6 pairs resolved");
});

it("keeps missing and unavailable distinct and does not read evidence for viewers", async () => {
  expect((await qualification(false)).html).toBe("");
  expect(read).not.toHaveBeenCalled();
  read.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Unavailable"));
  expect((await qualification()).html).toContain("No benchmark comparison was recorded");
  expect((await qualification()).html).toContain("Could not load benchmark qualification");
});

it.each([
  ["inconclusive", true, "Benchmark work is still pending."],
  ["inconclusive", false, "Inconclusive"],
  ["failed", true, "Failed"],
  ["stale", true, "A newer proposal revision exists."],
] as const)(
  "labels %s receipts independently of pending work (%s)",
  async (status, pending, expected) => {
    read.mockResolvedValue(receipt(status, pending));
    expect((await qualification()).html).toContain(expected);
  },
);
