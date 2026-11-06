// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDetailLink } from "./session-detail-link";
import { SESSION_PAGE_DATA_SERVER_TIMING } from "@/lib/performance/session-prefetch";

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: ComponentProps<"a"> & { prefetch?: boolean }) =>
    createElement("a", { ...props, "data-prefetch": String(prefetch) }),
}));

const href = "/w/acme/sessions/7";

class ResourceTiming {
  name = `${location.origin}${href}?_rsc=page`;
  startTime = 100;
  responseEnd = 120;
  responseStatus: number | undefined = 200;
  decodedBodySize = 500;
  transferSize = 700;
  serverTiming = [{ name: SESSION_PAGE_DATA_SERVER_TIMING }];

  constructor(overrides: Partial<ResourceTiming> = {}) {
    Object.assign(this, overrides);
  }
}

class ResourceObserver {
  static instances: ResourceObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(private readonly callback: PerformanceObserverCallback) {
    ResourceObserver.instances.push(this);
  }

  deliver(entries: ResourceTiming[]) {
    this.callback(
      { getEntries: () => entries } as unknown as PerformanceObserverEntryList,
      this as unknown as PerformanceObserver,
    );
  }
}

let now: number;
let resources: ResourceTiming[];
let frames: FrameRequestCallback[];

beforeEach(() => {
  vi.useFakeTimers();
  now = 100;
  resources = [];
  frames = [];
  ResourceObserver.instances = [];
  vi.stubGlobal("PerformanceResourceTiming", ResourceTiming);
  vi.stubGlobal("PerformanceObserver", ResourceObserver);
  vi.stubGlobal("performance", {
    now: () => now,
    getEntriesByType: () => resources,
    mark: vi.fn(),
    measure: vi.fn(),
    clearMarks: vi.fn(),
    clearMeasures: vi.fn(),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function clickSession() {
  const view = render(createElement(SessionDetailLink, { href }, "Open session"));
  const link = view.getByRole("link", { name: "Open session" });
  fireEvent.focusIn(link);
  now = 120;
  fireEvent.click(link);
  expect(router.prefetch).toHaveBeenCalledOnce();
  expect(router.push).not.toHaveBeenCalled();
  return ResourceObserver.instances[0]!;
}

async function paintFrame() {
  await act(async () => {
    const pending = frames.splice(0);
    pending.forEach((callback) => callback(now));
  });
}

describe("session prefetch completion", () => {
  it("stops waiting for a marked page but still navigates only after the final frame", async () => {
    const observer = clickSession();
    observer.deliver([new ResourceTiming({ serverTiming: [] })]);
    await act(() => vi.advanceTimersByTimeAsync(40));
    expect(frames).toHaveLength(0);
    now = 160;
    observer.deliver([new ResourceTiming({ responseEnd: 160 })]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(frames).toHaveLength(1);
    expect(router.push).not.toHaveBeenCalled();
    await paintFrame();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(href);
    expect(observer.disconnect).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(router.push).toHaveBeenCalledOnce();
  });

  it("keeps buffered marked-page evidence when a tree response is delivered again", async () => {
    resources = [new ResourceTiming()];
    const observer = clickSession();
    observer.deliver([new ResourceTiming({ serverTiming: [] })]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(frames).toHaveLength(1);
    expect(router.push).not.toHaveBeenCalled();
    await paintFrame();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(href);
  });

  it.each([
    ["unmarked", { serverTiming: [] }],
    ["failed", { responseStatus: 500 }],
    ["unsupported", { responseStatus: undefined }],
    ["stale", { startTime: 99 }],
    ["foreign", { name: `https://other.example${href}?_rsc=page` }],
  ] satisfies Array<[string, Partial<ResourceTiming>]>)(
    "retains the 80 ms fallback for %s page evidence",
    async (_kind, entry) => {
      const observer = clickSession();
      observer.deliver([new ResourceTiming(entry)]);
      await act(() => vi.advanceTimersByTimeAsync(79));
      expect(frames).toHaveLength(0);
      expect(router.push).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(frames).toHaveLength(1);
      expect(router.push).not.toHaveBeenCalled();
      await paintFrame();
      expect(router.push).toHaveBeenCalledExactlyOnceWith(href);
    },
  );

  it.each([
    { label: "no matching responses", bodyless: false },
    { label: "a bodyless response", bodyless: true },
  ])("retains the deadline for $label", async ({ bodyless }) => {
    const observer = clickSession();
    if (bodyless) observer.deliver([new ResourceTiming({ decodedBodySize: 0, transferSize: 0 })]);
    await act(() => vi.advanceTimersByTimeAsync(1_999));
    expect(frames).toHaveLength(0);
    expect(router.push).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(frames).toHaveLength(1);
    expect(router.push).not.toHaveBeenCalled();
    await paintFrame();
    expect(router.push).toHaveBeenCalledExactlyOnceWith(href);
  });
});
