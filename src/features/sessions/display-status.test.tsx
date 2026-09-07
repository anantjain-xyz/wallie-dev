// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider } from "@/components/ui/overlay-provider";
import { PipelineCard } from "@/features/pipeline/pipeline-page-client";
import { SessionLedgerRow } from "@/features/sessions/list/session-ledger-row";
import { sessionDisplayStatus } from "@/features/sessions/display-status";
import type { SessionListItem, SessionPhaseStatus } from "@/features/sessions/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(cleanup);

const session: SessionListItem = {
  id: "session",
  number: 1,
  title: "Shared status",
  archivedAt: null,
  createdAt: "2026-09-07T10:00:00Z",
  updatedAt: "2026-09-07T10:00:00Z",
  currentArtifactVersion: 1,
  currentStageId: "plan",
  currentStageName: "Plan",
  currentStagePosition: 1,
  currentStageSlug: "plan",
  pipelineId: "pipeline",
  workspaceId: "workspace",
  phaseStatus: "in_progress",
  latestRunStatus: null,
  linearIssueId: null,
  linearIssueUrl: null,
  pullRequestCount: 0,
  pullRequests: [],
  rejectionCount: 0,
  repositoryFullName: null,
};

function surfaces(item: SessionListItem) {
  return (
    <OverlayProvider>
      <PipelineCard
        {...item}
        initialNow={item.updatedAt}
        workspaceSlug="acme"
        pullRequestsJson="[]"
      />
      <SessionLedgerRow
        session={item}
        initialNow={item.updatedAt}
        workspaceSlug="acme"
        scope="all"
      />
    </OverlayProvider>
  );
}

const phases: SessionPhaseStatus[] = ["in_progress", "awaiting_review", "approved", "rejected"];
describe("shared session status", () => {
  it.each(phases)("renders matching compact pills for %s and its failed run", (phaseStatus) => {
    for (const latestRunStatus of [null, "error"] as const) {
      const view = render(surfaces({ ...session, phaseStatus, latestRunStatus }));
      const pills = view.container.querySelectorAll(".ui-status");
      expect(pills).toHaveLength(2);
      expect(pills[0]!.outerHTML).toBe(pills[1]!.outerHTML);
      expect(pills[1]!.getAttribute("data-status")).toBe(
        latestRunStatus === "error" ? "failed" : phaseStatus,
      );
      expect(pills[1]!.getAttribute("aria-label")).toBeTruthy();
      view.unmount();
    }
  });

  it("falls back to the stage for older payloads with no run status", () => {
    expect(sessionDisplayStatus({ phaseStatus: "rejected" })).toBe("rejected");
  });

  it("updates failed pills after a retry without treating archive state as workflow status", () => {
    const view = render(surfaces({ ...session, latestRunStatus: "error" }));
    expect(view.container.querySelectorAll('.ui-status[data-status="failed"]')).toHaveLength(2);
    view.rerender(surfaces({ ...session, latestRunStatus: "running" }));
    expect(view.container.querySelectorAll('.ui-status[data-status="in_progress"]')).toHaveLength(
      2,
    );
    view.rerender(
      surfaces({
        ...session,
        archivedAt: session.updatedAt,
        phaseStatus: "approved",
        latestRunStatus: "canceled",
      }),
    );
    expect(view.container.querySelectorAll('.ui-status[data-status="approved"]')).toHaveLength(2);
    view.rerender(surfaces({ ...session, phaseStatus: "rejected", latestRunStatus: "canceled" }));
    expect(view.container.querySelectorAll('.ui-status[data-status="rejected"]')).toHaveLength(2);
  });
});
