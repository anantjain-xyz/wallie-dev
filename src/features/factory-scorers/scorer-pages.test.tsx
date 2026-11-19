// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import ScorerDetailPage from "@/app/w/[workspaceSlug]/(app)/scorers/[scorerId]/page";
import ScorersPage from "@/app/w/[workspaceSlug]/(app)/scorers/page";
import type { FactoryScorerDefinition } from "@/lib/factory-scorers/contracts";

const mocks = vi.hoisted(() => ({
  loadScorerPageScope: vi.fn(),
  loadScorerDetail: vi.fn(),
  readScorerRevisionOwner: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("@/features/factory-scorers/scorer-pages-data", () => mocks);
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  redirect: (href: string) => {
    mocks.redirect(href);
    throw new Error("Redirected");
  },
  useRouter: () => ({ push: vi.fn() }),
}));

const workspaceId = "9f300000-0000-4000-8000-000000000001";
const factoryId = "9f300000-0000-4000-8000-000000000002";
const scorerId = "9f300000-0000-4000-8000-000000000003";
const latestId = "9f300000-0000-4000-8000-000000000004";
const historicalId = "9f300000-0000-4000-8000-000000000005";
const scorer = { id: scorerId, name: "Release quality", slug: "release-quality" };
const historical: FactoryScorerDefinition = {
  schemaVersion: 1,
  rubric: "\nPrevious rule.\n  Preserve this example.\n",
  requiredEvidence: ["validation_report"],
  scoring: { kind: "boolean", passValue: false },
};
const latest = { id: latestId, revision_number: 2 };
const previous = { id: historicalId, revision_number: 1 };
const ownerScope = {
  workspaceId,
  factory: { id: factoryId, name: "Release", status: "active" },
  canEdit: true,
  canBind: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadScorerPageScope.mockResolvedValue(ownerScope);
  mocks.loadScorerDetail.mockResolvedValue({
    scorer,
    latest,
    selected: { ...previous, definition: historical },
    activePins: [historicalId],
    revisions: [latest, previous],
    nextBeforeRevisionNumber: null,
  });
});
afterEach(cleanup);

function readDetail(revision = historicalId) {
  return ScorerDetailPage({
    params: Promise.resolve({ workspaceSlug: "acme", scorerId }),
    searchParams: Promise.resolve({ factory: factoryId, revision }),
  });
}

function readByRevision() {
  return ScorersPage({
    params: Promise.resolve({ workspaceSlug: "acme" }),
    searchParams: Promise.resolve({ factory: factoryId, revision: historicalId }),
  });
}

it("shows the exact historical rubric and links that revision for binding without allowing edits", async () => {
  const { container } = render(await readDetail());
  expect(screen.getByRole("heading", { name: "Revision 1" })).toBeVisible();
  expect(container.querySelector("pre")?.textContent).toBe(historical.rubric);
  expect(screen.getByText("Read-only revision")).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Rubric" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Configure binding" }).getAttribute("href")).toContain(
    `scorerRevision=${historicalId}`,
  );
});

it("gives a read-only member no authoring or binding controls even on the latest revision", async () => {
  mocks.loadScorerPageScope.mockResolvedValue({ ...ownerScope, canEdit: false, canBind: false });
  mocks.loadScorerDetail.mockResolvedValue({
    scorer,
    latest,
    selected: { ...latest, definition: historical },
    activePins: [],
    revisions: [latest],
  });
  render(await readDetail(latestId));
  expect(screen.getByRole("heading", { name: "Revision 2" })).toBeVisible();
  expect(screen.queryByRole("textbox", { name: "Rubric" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Configure binding" })).not.toBeInTheDocument();
});

it("redirects an exact revision link only after finding its owner in the selected factory", async () => {
  mocks.readScorerRevisionOwner.mockResolvedValueOnce(scorerId).mockResolvedValueOnce(null);
  await expect(readByRevision()).rejects.toThrow("Redirected");
  expect(mocks.readScorerRevisionOwner).toHaveBeenCalledWith(ownerScope, historicalId);
  expect(mocks.redirect).toHaveBeenCalledWith(
    `/w/acme/scorers/${scorerId}?factory=${factoryId}&revision=${historicalId}`,
  );
  await expect(readByRevision()).rejects.toThrow("Not found");
  expect(mocks.redirect).toHaveBeenCalledTimes(1);
});
