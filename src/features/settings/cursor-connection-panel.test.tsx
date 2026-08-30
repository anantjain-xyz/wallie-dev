// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CursorConnectionPanel } from "@/features/settings/cursor-connection-panel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CursorConnectionPanel", () => {
  it("synchronizes externally refreshed connection status", () => {
    const { rerender } = render(
      <CursorConnectionPanel
        initialStatus={{
          accountEmail: "person@example.com",
          checkedAt: "2026-08-29T22:00:00.000Z",
          connected: true,
        }}
      />,
    );

    expect(screen.getByLabelText("Connected")).toBeInTheDocument();

    rerender(
      <CursorConnectionPanel
        initialStatus={{
          checkedAt: "2026-08-29T22:01:00.000Z",
          connected: false,
          reconnectReason: "Cursor rejected the saved credential.",
          reconnectRequired: true,
        }}
      />,
    );

    expect(screen.getByText("Reconnect required")).toBeInTheDocument();
    expect(screen.getByText("Cursor rejected the saved credential.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect Cursor" })).toBeInTheDocument();
  });

  it("navigates a sign-in popup once per login URL", async () => {
    vi.useFakeTimers();
    const navigate = vi.fn();
    const popupLocation = {} as Location;
    Object.defineProperty(popupLocation, "href", { set: navigate });
    const popup = {
      close: vi.fn(),
      closed: false,
      location: popupLocation,
    } as unknown as Window;
    vi.spyOn(window, "open").mockReturnValue(popup);
    const flow = {
      expiresAt: "2099-01-01T00:00:00.000Z",
      flowId: "flow-1",
      loginUrl: "https://cursor.com/login/flow-1",
      status: "prompted",
    };
    let pollCount = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") pollCount += 1;
      return Promise.resolve({
        json: async () =>
          init?.method === "POST"
            ? { ...flow, loginUrl: undefined, status: "starting" }
            : {
                ...flow,
                loginUrl:
                  pollCount >= 3 ? "https://cursor.com/login/reclaimed-flow-1" : flow.loginUrl,
              },
        ok: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CursorConnectionPanel
        initialStatus={{ checkedAt: "2026-08-29T22:00:00.000Z", connected: false }}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in with Cursor" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
