// @vitest-environment jsdom

import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStageWorkspace, type SessionStageFocus } from "./session-stage-workspace";

import { SessionRunSurface, SessionRunHistory } from "./session-activity-presentation";

afterEach(cleanup);

describe("SessionStageWorkspace", () => {
  it("places counted history outside the run surface and removes nested disclosure for artifacts", async () => {
    const content = (focus: SessionStageFocus, count: number) => (
      <SessionStageWorkspace
        focus={focus}
        stageName="Build"
        stageSlug="build"
        artifact={<p>Output</p>}
        emptyText="Not started"
        reviewControls={null}
        activity={
          <>
            <SessionRunSurface>
              <p>Current run</p>
            </SessionRunSurface>
            <SessionRunHistory count={count} hasMore>
              <p>Older runs</p>
            </SessionRunHistory>
          </>
        }
      />
    );
    const view = render(content("run", 2));
    const older = screen.getByText("Older runs").closest("details")!;
    expect(older.closest(".ui-sheet")).toBeNull();
    expect(screen.getByText("Current run").closest(".ui-sheet")).not.toBeNull();
    expect(older.querySelector("summary")?.textContent).toBe("Run history 2+");
    expect(older.open).toBe(false);
    view.rerender(content("artifact", 4));
    await waitFor(() => expect(older.open).toBe(true));
    expect(older.querySelector("summary")?.hidden).toBe(true);
    expect(older.querySelector("summary")?.textContent).toBe("Run history 4+");
    expect(screen.getByText("Current run").closest(".ui-sheet")).toBeNull();
  });

  it("keeps live activity and review state mounted when the artifact arrives or a rerun starts", async () => {
    const activityMount = vi.fn();
    const activityUnmount = vi.fn();
    const reviewMount = vi.fn();
    function Activity() {
      useEffect(() => {
        activityMount();
        return activityUnmount;
      }, []);
      return <p>Live activity</p>;
    }
    function Review() {
      useEffect(() => {
        reviewMount();
      }, []);
      return null;
    }
    const content = (focus: SessionStageFocus) => (
      <SessionStageWorkspace
        activity={<Activity />}
        artifact={<p>Artifact body</p>}
        emptyText="Not started"
        focus={focus}
        reviewControls={<Review />}
        stageName="Build"
        stageSlug="build"
      />
    );
    const view = render(content("run"));
    const history = screen.getByText("Run history").closest("details")!;
    expect(history.open).toBe(true);
    expect(screen.queryByText("Artifact body")).toBeNull();
    view.rerender(content("artifact"));
    await waitFor(() => expect(history.open).toBe(false));
    expect(screen.getByText("Artifact body")).toBeTruthy();
    expect(screen.getByText("Live activity")).toBeTruthy();
    view.rerender(content("run"));
    expect(history.open).toBe(true);
    expect(activityMount).toHaveBeenCalledTimes(1);
    expect(activityUnmount).not.toHaveBeenCalled();
    expect(reviewMount).toHaveBeenCalledTimes(1);
  });

  it("mounts an earlier artifact only when requested, and resets disclosure for another stage", () => {
    const content = (stageSlug: string) => (
      <SessionStageWorkspace
        activity={<p>Activity</p>}
        artifact={<p>Earlier {stageSlug} output</p>}
        emptyText="Not started"
        focus="run"
        reviewControls={null}
        stageName={stageSlug}
        stageSlug={stageSlug}
      />
    );
    const view = render(content("build"));
    expect(screen.queryByText("Earlier build output")).toBeNull();
    const earlier = screen.getByText("Previous artifact").closest("details")!;
    earlier.open = true;
    fireEvent(earlier, new Event("toggle"));
    expect(screen.getByText("Earlier build output")).toBeTruthy();
    view.rerender(content("verify"));
    expect(screen.queryByText("Earlier build output")).toBeNull();
    expect(screen.queryByText("Earlier verify output")).toBeNull();
  });
});
