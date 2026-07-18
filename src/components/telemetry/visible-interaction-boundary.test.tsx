// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => ({ finishInteraction: vi.fn() }));

vi.mock("@/lib/telemetry/interaction-rum", () => telemetry);

import { VisibleInteractionBoundary } from "@/components/telemetry/visible-interaction-boundary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("VisibleInteractionBoundary", () => {
  it("finishes navigation after the target content has painted", () => {
    let paint: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        paint = callback;
        return 42;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    render(<VisibleInteractionBoundary action="pipeline_to_sessions" />);

    expect(telemetry.finishInteraction).not.toHaveBeenCalled();
    paint?.(10);
    expect(telemetry.finishInteraction).toHaveBeenCalledWith("pipeline_to_sessions", "success");
  });

  it("cancels an unfinished target-page paint on unmount", () => {
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 7),
    );
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);

    const view = render(<VisibleInteractionBoundary action="sessions_to_detail" />);
    view.unmount();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(telemetry.finishInteraction).not.toHaveBeenCalled();
  });
});
