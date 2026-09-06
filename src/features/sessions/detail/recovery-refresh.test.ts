import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionRecoveryRefresh } from "@/features/sessions/detail/recovery-refresh";

describe("session recovery refresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const refresh = vi.fn();
    const isAvailable = vi.fn(() => true);
    const isBusy = vi.fn(() => false);
    return {
      refresh,
      isAvailable,
      isBusy,
      recovery: createSessionRecoveryRefresh({ refresh, isAvailable, isBusy }),
    };
  }

  it("does not refetch on a healthy initial subscription", () => {
    const { recovery, refresh } = setup();
    recovery.onStatus("SUBSCRIBED");
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reconciles a recovered connection, including a failed initial connection", () => {
    const { recovery, refresh } = setup();
    recovery.onStatus("CHANNEL_ERROR");
    recovery.onStatus("SUBSCRIBED");
    recovery.request(); // online/visibility can arrive in the same burst
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    recovery.onStatus("CLOSED");
    recovery.onStatus("SUBSCRIBED");
    vi.advanceTimersByTime(9_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("waits for active mutations to settle", () => {
    const { recovery, refresh, isBusy } = setup();
    isBusy.mockReturnValue(true);
    recovery.request();
    vi.advanceTimersByTime(2_200);
    expect(refresh).not.toHaveBeenCalled();
    isBusy.mockReturnValue(false);
    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not poll hidden or offline pages and resumes on a recovery signal", () => {
    const { recovery, refresh, isAvailable } = setup();
    recovery.request();
    isAvailable.mockReturnValue(false);
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    isAvailable.mockReturnValue(true);
    recovery.request();
    vi.advanceTimersByTime(200);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("cancels pending work and ignores teardown subscription callbacks", () => {
    const { recovery, refresh } = setup();
    recovery.request();
    recovery.dispose();
    recovery.onStatus("CLOSED");
    recovery.onStatus("SUBSCRIBED");
    recovery.request();
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
