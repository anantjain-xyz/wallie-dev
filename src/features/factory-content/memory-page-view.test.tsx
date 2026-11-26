// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { loadMemoryPage, MemoryEligibility } from "./content-data";
import { MemoryPageView } from "./memory-page-view";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const id = (suffix: string) => `58200000-0000-4000-8000-0000000000${suffix}`;
const scope = {
  workspaceId: id("01"),
  workspaceSlug: "atlas",
  factory: { id: id("02"), status: "active" as const, name: "Atlas", isDefault: true },
};
const history = {
  id: id("04"),
  revision_number: 1,
  content_sha256: "a".repeat(64),
  expires_at: "2025-01-01T00:00:00Z",
  supersedes_revision_id: null,
  created_at: "2024-01-01T00:00:00Z",
};
const live = { ...history, id: id("05"), revision_number: 2, expires_at: null };
const event = {
  id: id("06"),
  revision_id: history.id,
  action: "approved",
  actor_member_id: id("07"),
  created_at: history.created_at,
};
type ViewData = Awaited<ReturnType<typeof loadMemoryPage>>;
const detail: NonNullable<ViewData["detail"]> = {
  memory: {
    id: id("03"),
    title: "Release checklist",
    source_session_id: id("08"),
    source_artifact_id: id("09"),
    source_artifact_version: 3,
    source_run_id: id("10"),
    source_attempt_count: 2,
    source_commit_sha: "a".repeat(40),
    source_content_sha256: history.content_sha256,
    current_revision_id: live.id,
    current_approval_id: id("11"),
    pending_revision_id: null,
    forgotten_at: null,
    created_at: history.created_at,
  },
  revision: history,
  eligibility: "eligible",
  history: [live, history],
  nextRevision: 1,
  decisions: [event],
  requestedDecision: event,
  actorNames: { [event.actor_member_id]: "Maya Chen" },
  body: "Historical checklist",
  sourceSessionNumber: 12,
  sourceArtifactStage: "build",
};
const asOf = "2026-11-25T00:00:00Z";
const listQuery = { q: "checklist", after: id("13") };
const activeQuery = { memory: detail.memory.id, ...listQuery };

function showDetail(
  values: Partial<typeof detail>,
  query: Parameters<typeof loadMemoryPage>[1] = activeQuery,
) {
  return render(
    <MemoryPageView
      data={{ asOf, detail: { ...detail, ...values }, list: null }}
      query={query}
      scope={scope}
    />,
  );
}

afterEach(() => {
  cleanup();
  router.refresh.mockClear();
});

it("keeps an exact historical receipt read-only and returns to the filtered list or live revision", () => {
  showDetail({}, { ...activeQuery, revision: history.id, decision: event.id });
  expect(screen.queryByRole("heading", { name: "Manage memory" })).toBeNull();
  expect(screen.queryByRole("button", { name: /forget memory/i })).toBeNull();
  const note = screen.getByRole("region", { name: "Stored memory note" });
  expect(note.tabIndex).toBe(0);
  expect(note.textContent).toBe("Historical checklist");
  expect(screen.getByRole("link", { name: "Revision 1" }).getAttribute("aria-current")).toBe(
    "true",
  );
  expect(screen.getByText("Maya Chen")).toBeTruthy();
  expect(screen.getByText(event.actor_member_id).closest("details")?.open).toBe(false);
  expect(screen.getByRole("link", { name: "Session #12 · Attempt 2" })).toBeTruthy();
  const readLink = (name: string) =>
    new URL(screen.getByRole("link", { name }).getAttribute("href")!, "https://wallie.example.test")
      .searchParams;
  expect(Object.fromEntries(readLink("All memory"))).toEqual({
    factory: scope.factory.id,
    ...listQuery,
  });
  expect(Object.fromEntries(readLink("Open current or pending revision"))).toEqual({
    factory: scope.factory.id,
    ...activeQuery,
  });
  expect(readLink("Older revisions").get("decision")).toBe(event.id);
});

it("does not render management for a missing revision or a receipt for the live revision", () => {
  const missing = showDetail(
    { revision: null, body: null },
    { ...activeQuery, revision: id("99") },
  );
  expect(screen.getByText(/requested memory revision is unavailable/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open current or pending revision" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save pending revision" })).toBeNull();
  missing.unmount();
  showDetail({ revision: live }, { ...activeQuery, revision: live.id, decision: event.id });
  expect(screen.queryByRole("heading", { name: "Manage memory" })).toBeNull();
});

it("shows the live correction consequence and never copies historical text into a fresh correction", () => {
  const selected = showDetail(
    { revision: live, body: "Live checklist" },
    { ...activeQuery, revision: live.id },
  );
  expect(screen.getByLabelText<HTMLTextAreaElement>("Memory note").value).toBe("Live checklist");
  expect(screen.getByText(/Saving withdraws any current approval/)).toBeTruthy();
  selected.unmount();
  showDetail({
    memory: { ...detail.memory, current_revision_id: null, current_approval_id: null },
    eligibility: "no-approval",
  });
  expect(screen.getByLabelText<HTMLTextAreaElement>("Memory note").value).toBe("");
  expect(screen.getByText(/without copying the historical note/)).toBeTruthy();
});

it.each([
  [history, null, "expired", /future expiry or no expiry/],
  [live, null, "note-unavailable", /with a note before approving/],
] as const)(
  "exposes the review state but disables invalid approval (%j)",
  (revision, body, eligibility, reason) => {
    showDetail({
      revision,
      body,
      eligibility,
      memory: {
        ...detail.memory,
        current_revision_id: null,
        current_approval_id: null,
        pending_revision_id: revision.id,
      },
    });
    expect(screen.getByText(reason)).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Approve revision" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Reject revision" }).disabled,
    ).toBe(false);
  },
);

it("keeps approval and current eligibility distinct on the index", () => {
  const display = (title: string, id: string, eligibility: MemoryEligibility) => ({
    ...detail.memory,
    id,
    title,
    eligibility,
  });
  render(
    <MemoryPageView
      query={{}}
      scope={scope}
      data={{
        asOf,
        detail: null,
        list: {
          nextMemory: undefined,
          proposalAvailability: "unavailable",
          items: [
            display("Release checklist", id("03"), "expired"),
            display("Build checklist", id("14"), "eligible"),
          ],
        },
      }}
    />,
  );
  expect(screen.getByRole("searchbox", { name: "Search memory titles" })).toBeTruthy();
  expect(screen.getAllByText("Approved")).toHaveLength(2);
  expect(screen.getByText("Not eligible · expired")).toBeTruthy();
  expect(screen.getByText("Eligible for future runs")).toBeTruthy();
});

it("offers recovery for archived and failed proposal links without claiming import occurred", () => {
  const query = { proposal: id("09"), version: 3 };
  const data = {
    asOf,
    detail: null,
    list: { items: [], proposalAvailability: "archived" as const, nextMemory: undefined },
  };
  const fixture = render(
    <MemoryPageView
      activeFactory={scope.factory}
      data={data}
      query={query}
      scope={{
        ...scope,
        factory: { ...scope.factory, id: id("15"), status: "archived" },
      }}
    />,
  );
  expect(screen.getByRole("heading", { name: "Archived · read-only" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open memory in an active factory" })).toBeTruthy();
  expect(screen.queryByText(/already imported/)).toBeNull();
  fixture.rerender(
    <MemoryPageView
      data={{ ...data, list: { ...data.list, proposalAvailability: "error" } }}
      query={query}
      scope={scope}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(router.refresh).toHaveBeenCalledOnce();
  expect(screen.queryByText(/already imported/)).toBeNull();
});
