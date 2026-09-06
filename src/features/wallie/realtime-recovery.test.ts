// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRealtimeRecovery,
  RecoveryDeferredError,
  type RecoverySource,
} from "./realtime-recovery";

describe("page realtime recovery", () => {
  const cleanups: Array<() => void> = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.useRealTimers();
  });

  function setup() {
    const online = vi.fn(() => true);
    const visible = vi.fn(() => true);
    const report = vi.fn();
    const recovery = createRealtimeRecovery({
      online,
      available: () => online() && visible(),
      random: () => 0.5,
      report,
    });
    cleanups.push(recovery.attach());
    function source(
      key: string,
      required = true,
      refresh = vi.fn<RecoverySource["refresh"]>().mockResolvedValue(),
    ) {
      const callbacks: Array<(status: string, error?: unknown) => void> = [];
      const guards: Array<() => boolean> = [];
      const remove = vi.fn();
      const dispose = recovery.register({
        key,
        required,
        role: required ? "runs" : "history",
        refresh,
        subscribe: (callback, isCurrent) => {
          callbacks.push(callback);
          guards.push(isCurrent);
          return () => {
            remove();
            callback("CLOSED");
          };
        },
      });
      cleanups.push(dispose);
      return {
        callbacks,
        guards,
        refresh,
        remove,
        dispose,
        status: (status: string, error?: unknown) => callbacks.at(-1)!(status, error),
      };
    }
    return { recovery, online, visible, report, source };
  }

  it("ignores intentional closes and late callbacks without poisoning healthy sources", async () => {
    const { recovery, source } = setup();
    const active = source("active");
    const history = source("old", false);
    active.status("SUBSCRIBED");
    history.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    history.dispose();
    history.status("CHANNEL_ERROR");
    history.status("SUBSCRIBED");
    expect(history.guards[0]()).toBe(false);
    expect(recovery.getSnapshot()).toEqual({ connection: "live", sources: { active: "live" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(active.refresh).toHaveBeenCalledTimes(1);
    expect(history.remove).toHaveBeenCalledTimes(1);
  });

  it("waits for catch-up, polls an outage, and stops polling only after recovery", async () => {
    const { recovery, source } = setup();
    const run = source("run");
    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    run.status("CHANNEL_ERROR");
    expect(recovery.getSnapshot().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(200);
    expect(recovery.getSnapshot().connection).toBe("degraded");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.refresh).toHaveBeenCalledTimes(3);
    let resolve!: () => void;
    run.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    run.status("SUBSCRIBED");
    expect(recovery.getSnapshot().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(200);
    expect(recovery.getSnapshot().connection).toBe("reconnecting");
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.getSnapshot().connection).toBe("recovered");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recovery.getSnapshot().connection).toBe("live");
    expect(run.refresh).toHaveBeenCalledTimes(4);
  });

  it("keeps failed catch-up visible despite healthy subscriptions and retries it", async () => {
    const { recovery, source } = setup();
    const run = source("run");
    run.refresh.mockRejectedValueOnce(new Error("HTTP unavailable"));
    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    expect(recovery.getSnapshot().connection).toBe("failed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recovery.getSnapshot().connection).toBe("recovered");
  });

  it("coalesces manual retries and bounds hung reads", async () => {
    const { recovery, source } = setup();
    const run = source("run");
    run.refresh.mockImplementationOnce(() => new Promise(() => {}));
    run.status("SUBSCRIBED");
    recovery.retry();
    recovery.retry();
    await vi.advanceTimersByTimeAsync(200);
    recovery.retry();
    recovery.retry();
    expect(run.refresh).toHaveBeenCalledTimes(1);
    const signal = run.refresh.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signal.aborted).toBe(true);
    expect(recovery.getSnapshot().connection).toBe("failed");
    recovery.retry();
    recovery.retry();
    await vi.advanceTimersByTimeAsync(200);
    expect(run.refresh).toHaveBeenCalledTimes(2);
    expect(recovery.getSnapshot().connection).toBe("recovered");
  });

  it("recreates only unexpectedly closed sources using capped backoff", async () => {
    const { source } = setup();
    const run = source("run");
    const other = source("other");
    other.status("SUBSCRIBED");
    for (const delay of [1_000, 2_000, 5_000, 10_000, 30_000, 30_000]) {
      const count = run.callbacks.length;
      run.status("CLOSED");
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(run.callbacks).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(run.callbacks).toHaveLength(count + 1);
    }
    expect(other.remove).not.toHaveBeenCalled();
    expect(run.guards[0]()).toBe(false);
  });

  it("gives SDK retries 30 seconds before replacing a failed subscription", async () => {
    const { source } = setup();
    const run = source("run");
    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    run.status("TIMED_OUT");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run.remove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.remove).toHaveBeenCalledTimes(1);
  });

  it("scopes a failed historical read to history while refreshing required session data", async () => {
    const { recovery, source } = setup();
    const session = source("session");
    const history = source("history", false);
    session.status("SUBSCRIBED");
    history.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    history.refresh.mockRejectedValue(new Error("History read failed"));
    history.status("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(200);
    expect(recovery.getSnapshot().connection).toBe("live");
    expect(recovery.getSnapshot().sources.history).toBe("failed");
    expect(session.refresh).toHaveBeenCalledTimes(2);
  });

  it("does no reads or custom retries hidden/offline and catches up on return", async () => {
    const { recovery, source, online, visible } = setup();
    const run = source("run");
    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(recovery.getSnapshot().connection).toBe("offline");
    run.status("CLOSED");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.refresh).toHaveBeenCalledTimes(1);
    expect(run.remove).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    visible.mockReturnValue(false);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.refresh).toHaveBeenCalledTimes(1);
    visible.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(200);
    expect(run.refresh).toHaveBeenCalledTimes(2);
    expect(run.remove).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh subscription after offline even without an SDK failure", async () => {
    const { recovery, source, online, report } = setup();
    const run = source("run");
    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    const oldStatus = run.callbacks[0];

    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(run.guards[0]()).toBe(false);
    oldStatus("SUBSCRIBED");
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(200);
    expect(run.callbacks).toHaveLength(2);
    expect(recovery.getSnapshot().connection).toBe("degraded");
    expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ event: "recovered" }));
    oldStatus("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.refresh).toHaveBeenCalledTimes(3);
    expect(recovery.getSnapshot().connection).toBe("degraded");

    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    expect(recovery.getSnapshot().connection).toBe("recovered");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.refresh).toHaveBeenCalledTimes(4);
  });

  it("invalidates an in-flight catch-up on offline and refreshes immediately on return", async () => {
    const { recovery, source, online } = setup();
    const run = source("run");
    let finishOldRead!: () => void;
    run.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOldRead = resolve;
        }),
    );
    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    const signal = run.refresh.mock.calls[0][0];
    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(signal.aborted).toBe(true);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    finishOldRead();
    await vi.advanceTimersByTimeAsync(200);
    expect(run.refresh).toHaveBeenCalledTimes(2);
    expect(recovery.getSnapshot().connection).toBe("degraded");
  });

  it("defers busy optimistic actions without reporting a refresh failure", async () => {
    const { recovery, source, report } = setup();
    const run = source("run");
    run.refresh.mockRejectedValueOnce(new RecoveryDeferredError());
    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    expect(recovery.getSnapshot().connection).toBe("connecting");
    expect(report).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recovery.getSnapshot().connection).toBe("live");
  });

  it("never lets obsolete refreshes announce restoration and sanitizes SDK errors", async () => {
    const { recovery, source, report } = setup();
    let resolve!: () => void;
    const old = source(
      "run",
      true,
      vi.fn(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      ),
    );
    old.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    old.dispose();
    const current = source("run");
    current.status("CHANNEL_ERROR", new Error("JWT expired: secret-token"));
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.getSnapshot().connection).toBe("reconnecting");
    expect(JSON.stringify(report.mock.calls)).not.toContain("secret-token");
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ reason: "auth" }));
  });

  it("requires a new catch-up when a channel rejoins during an older read", async () => {
    const { recovery, source } = setup();
    const run = source("run");
    run.status("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(200);
    let finishOlder!: () => void;
    let finishCatchUp!: () => void;
    run.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishOlder = resolve;
        }),
    );
    run.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCatchUp = resolve;
        }),
    );
    run.status("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(200);
    run.status("SUBSCRIBED");
    finishOlder();
    await vi.advanceTimersByTimeAsync(200);
    expect(recovery.getSnapshot().connection).toBe("reconnecting");
    finishCatchUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.getSnapshot().connection).toBe("recovered");
  });

  it("treats a subscription with no acknowledgement as an outage after the watchdog", async () => {
    const { recovery, source } = setup();
    const run = source("run");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.remove).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(200);
    expect(run.refresh).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot().connection).toBe("degraded");
  });
});
