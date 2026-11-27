// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PipelineFactoryOverview } from "@/features/pipeline/pipeline-factory-overview";
import type { PipelineBoardLane } from "@/features/pipeline/types";

const docs = { id: "docs-id", name: "Operations", status: "active" } as const;
const releases = { id: "mobile-id", name: "Operations", status: "active" } as const;
const empty = { id: "empty-id", name: "Warehouse", status: "active" } as const;

function stage(
  id: string,
  name: string,
  factory: PipelineBoardLane["factory"],
  pipeline: string,
): PipelineBoardLane {
  return {
    cardIds: [id],
    cursor: null,
    description: "",
    factory,
    id,
    name,
    pipeline: { id: pipeline.replaceAll(" ", "-"), isDefault: false, name: pipeline },
    position: 1,
    slug: "plan",
    totalCount: 1,
  };
}

function overview(lanes: PipelineBoardLane[], filtersActive = false) {
  return render(
    <PipelineFactoryOverview
      busy={false}
      factories={[docs, releases, empty]}
      filtersActive={filtersActive}
      lanes={lanes}
      renderStage={(lane) => <p>{lane.cardIds[0]}</p>}
      workspaceSlug="acme"
    />,
  );
}

afterEach(cleanup);

describe("All factories overview", () => {
  it("uses factory IDs and actual stage names even when display names and stage keys collide", () => {
    overview([
      stage("draft", "Sketch", docs, "Editorial"),
      stage("release", "Production readiness", releases, "Mobile release"),
      stage("incident", "Incident risk assessment", releases, "Hotfix"),
    ]);

    expect(screen.queryByRole("tablist")).toBeNull();
    const [docsGroup, releasesGroup] = screen.getAllByRole("region", { name: "Operations" });
    expect(within(docsGroup!).getByRole("heading", { name: "Sketch" })).toBeTruthy();
    expect(within(docsGroup!).queryByText("Production readiness")).toBeNull();
    expect(
      within(releasesGroup!).getByRole("region", {
        name: "Production readiness Mobile release",
      }),
    ).toBeTruthy();
    expect(
      within(releasesGroup!).getByRole("region", { name: "Incident risk assessment Hotfix" }),
    ).toBeTruthy();
    expect(within(docsGroup!).getByRole("link").getAttribute("href")).toBe(
      "/w/acme?factory=docs-id",
    );
    expect(within(releasesGroup!).getByRole("link").getAttribute("href")).toBe(
      "/w/acme?factory=mobile-id",
    );
    expect(
      within(screen.getByRole("region", { name: "Warehouse" })).getByText("No active sessions"),
    ).toBeTruthy();
  });

  it("shows one no-match state instead of repeating it across factories", () => {
    overview([], true);
    expect(screen.getByText("No matching sessions")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open board for Warehouse" })).toBeNull();
  });
});
