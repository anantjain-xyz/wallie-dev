// @vitest-environment jsdom

import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatLocalizedTimestamp,
  formatRelativeTimestamp,
  formatUtcTimestamp,
  nextRelativeUpdateDelay,
  TimeDisplay,
} from "@/components/shared/time-display";

const timestamp = "2026-03-08T09:30:00.000Z";
const initialNow = "2026-03-08T09:35:30.000Z";

describe("TimeDisplay", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the explicit server reference instant for deterministic relative text", () => {
    expect(formatRelativeTimestamp(timestamp, initialNow)).toBe("5m ago");
    expect(
      renderToString(<TimeDisplay initialNow={initialNow} value={timestamp} variant="relative" />),
    ).toContain("5m ago");
  });

  it("uses one reference instant for every relative time in a server render", () => {
    const html = renderToString(
      <>
        <TimeDisplay
          initialNow="2026-03-08T09:35:30.000Z"
          value="2026-03-08T09:34:31.000Z"
          variant="relative"
        />
        <TimeDisplay
          initialNow="2026-03-08T09:35:30.000Z"
          value="2026-03-08T09:34:29.000Z"
          variant="relative"
        />
      </>,
    );

    expect(html).toMatch(/just now.*1m ago/);
  });

  it("hydrates without changing the first client render", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(initialNow));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const serverHtml = renderToString(
      <TimeDisplay initialNow={initialNow} value={timestamp} variant="relative" />,
    );
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);

    await act(async () => {
      hydrateRoot(
        container,
        <TimeDisplay initialNow={initialNow} value={timestamp} variant="relative" />,
      );
    });

    expect(container.textContent).toBe("5m ago");
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/hydration|did not match/i);
  });

  it("uses a UTC fallback and formats DST boundaries in the selected client timezone", () => {
    expect(formatUtcTimestamp(timestamp)).toBe("2026-03-08 09:30 UTC");
    expect(
      formatLocalizedTimestamp("2026-03-08T09:30:00.000Z", {
        locale: "en-US",
        timeZone: "America/Los_Angeles",
      }),
    ).toContain("1:30 AM PST");
    expect(
      formatLocalizedTimestamp("2026-03-08T10:30:00.000Z", {
        locale: "en-US",
        timeZone: "America/Los_Angeles",
      }),
    ).toContain("3:30 AM PDT");
  });

  it("schedules inactive labels at their next semantic boundary", () => {
    const nowMs = Date.parse(initialNow);
    expect(nextRelativeUpdateDelay(timestamp, nowMs)).toBe(30_000);
    expect(
      nextRelativeUpdateDelay("2026-03-08T07:30:00.000Z", Date.parse("2026-03-08T09:45:00Z")),
    ).toBe(45 * 60_000);
  });

  it("renders a stable placeholder for active elapsed time on the server", () => {
    const html = renderToString(
      <TimeDisplay active initialNow={initialNow} value={timestamp} variant="elapsed" />,
    );

    expect(html).toContain(">—</time>");
  });

  it("starts active elapsed time after hydration and advances on second boundaries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T09:35:30.000Z"));
    const serverHtml = renderToString(
      <TimeDisplay
        active
        initialNow={initialNow}
        value="2026-03-08T09:35:28.250Z"
        variant="elapsed"
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.append(container);

    await act(async () => {
      hydrateRoot(
        container,
        <TimeDisplay
          active
          initialNow={initialNow}
          value="2026-03-08T09:35:28.250Z"
          variant="elapsed"
        />,
      );
    });
    expect(container.textContent).toBe("1s");

    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe("2s");
  });
});
