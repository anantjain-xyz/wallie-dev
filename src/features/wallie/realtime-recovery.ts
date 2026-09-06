import type { WallieRealtimeConnectionState } from "./activity-summary";
import { recordRealtimeRecovery, type RecoveryDiagnostic } from "@/lib/telemetry/realtime-recovery";

export const RECOVERY_POLL_MS = 10_000;
export const RECOVERY_WATCHDOG_MS = 30_000;
const RETRY_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Busy optimistic mutations defer reconciliation without reporting an outage. */
export class RecoveryDeferredError extends Error {}

export type RecoverySource = {
  key: string;
  role: RecoveryDiagnostic["role"];
  required: boolean;
  subscribe: (
    onStatus: (status: string, error?: unknown) => void,
    isCurrent: () => boolean,
  ) => () => void;
  refresh: (signal: AbortSignal) => Promise<void>;
};
type Entry = RecoverySource & {
  generation: number;
  revision: number;
  closed: boolean;
  cleanup?: () => void;
  subscribed: boolean;
  synced: boolean;
  interrupted: boolean;
  refreshFailed: boolean;
  retryAt: number | null;
  retries: number;
};
type Snapshot = {
  connection: WallieRealtimeConnectionState;
  sources: Record<string, WallieRealtimeConnectionState>;
};
const initialSnapshot: Snapshot = { connection: "connecting", sources: {} };

/** Owns page subscriptions, never the shared Supabase socket. */
export function createRealtimeRecovery(
  options: {
    available?: () => boolean;
    online?: () => boolean;
    random?: () => number;
    report?: (event: RecoveryDiagnostic) => void;
  } = {},
) {
  const online = options.online ?? (() => typeof navigator === "undefined" || navigator.onLine);
  const available =
    options.available ??
    (() => online() && (typeof document === "undefined" || document.visibilityState === "visible"));
  const report = options.report ?? recordRealtimeRecovery;
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot = initialSnapshot;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let flight: AbortController | null = null;
  let pendingRefresh = false;
  let pollAt: number | null = null;
  let outageAt: number | null = null;
  let recoveredUntil = 0;

  function sourceState(entry: Entry): WallieRealtimeConnectionState {
    if (!online()) return "offline";
    if (entry.refreshFailed) return "failed";
    if (entry.subscribed && entry.synced) return "live";
    if (entry.interrupted) return entry.synced ? "degraded" : "reconnecting";
    return "connecting";
  }

  function publish() {
    const sources = Object.fromEntries(
      [...entries].map(([key, entry]) => [key, sourceState(entry)]),
    );
    const required = [...entries.values()].filter((entry) => entry.required);
    const states = required.map((entry) => sources[entry.key]);
    let connection: WallieRealtimeConnectionState = "live";
    if (!online()) connection = "offline";
    else if (!states.length) connection = "connecting";
    else {
      for (const state of ["failed", "reconnecting", "connecting", "degraded"] as const) {
        if (states.includes(state)) {
          connection = state;
          break;
        }
      }
    }
    if (connection === "live" && outageAt !== null) {
      report({
        event: "recovered",
        role: "page",
        reason: "none",
        duration_ms: Date.now() - outageAt,
      });
      outageAt = null;
      recoveredUntil = Date.now() + 4_000;
    }
    if (connection === "live" && recoveredUntil > Date.now()) connection = "recovered";
    const next = { connection, sources };
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    }
  }

  function interrupt(entry: Entry) {
    entry.interrupted = true;
    recoveredUntil = 0;
    if (entry.required && outageAt === null) outageAt = Date.now();
  }

  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (!available() || !entries.size) return;
    const due = [...entries.values()].flatMap((entry) =>
      entry.retryAt === null ? [] : [entry.retryAt],
    );
    if (pollAt !== null) due.push(pollAt);
    if (recoveredUntil > Date.now()) due.push(recoveredUntil);
    if (!due.length) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (!available()) return;
        for (const entry of entries.values()) {
          if (entry.retryAt !== null && entry.retryAt <= Date.now()) {
            interrupt(entry);
            connect(entry);
            requestRefresh();
          }
        }
        if (pollAt !== null && pollAt <= Date.now()) {
          pollAt = null;
          if (flight) requestRefresh();
          else void refresh();
        }
        publish();
        schedule();
      },
      Math.max(0, Math.min(...due) - Date.now()),
    );
  }

  function backoff(entry: Entry) {
    const delay = RETRY_DELAYS[Math.min(entry.retries++, RETRY_DELAYS.length - 1)];
    return delay * (0.8 + (options.random ?? Math.random)() * 0.4);
  }

  function connect(entry: Entry) {
    const generation = ++entry.generation;
    entry.cleanup?.(); // Invalidate callbacks BEFORE intentional removal.
    entry.cleanup = undefined;
    entry.subscribed = false;
    entry.closed = false;
    entry.retryAt = Date.now() + RECOVERY_WATCHDOG_MS;
    const isCurrent = () => entries.get(entry.key) === entry && generation === entry.generation;
    entry.cleanup = entry.subscribe((status, error) => {
      if (!isCurrent()) return;
      if (status === "SUBSCRIBED") {
        entry.revision++;
        entry.subscribed = true;
        entry.synced = false;
        entry.retryAt = null;
        requestRefresh();
      } else if (["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"].includes(status)) {
        const firstFailure = !entry.interrupted || entry.subscribed;
        entry.subscribed = false;
        if (firstFailure) {
          entry.synced = false;
          entry.revision++;
        }
        interrupt(entry);
        if (status === "CLOSED" && !entry.closed) {
          entry.closed = true;
          entry.retryAt = Date.now() + backoff(entry);
        } else entry.retryAt ??= Date.now() + RECOVERY_WATCHDOG_MS;
        if (firstFailure) {
          report({
            event: "subscription_failed",
            role: entry.role,
            reason: failureCategory(status, error),
            duration_ms: 0,
          });
          requestRefresh();
        }
      }
      publish();
      schedule();
    }, isCurrent);
    publish();
    schedule();
  }

  function requestRefresh(delay = 200) {
    pendingRefresh = true;
    if (!available() || flight || refreshTimer !== undefined) return;
    // Batch subscription acknowledgements and simultaneous recovery signals.
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, delay);
  }

  async function refresh() {
    if (!available() || flight || !entries.size) return;
    pendingRefresh = false;
    const controller = new AbortController();
    flight = controller;
    pollAt = null;
    const batch = [...entries.values()].map((entry) => ({
      entry,
      generation: entry.generation,
      revision: entry.revision,
    }));
    // Bound hung fetches as well as failed ones; one flight per page.
    const timeout = setTimeout(() => controller.abort(), RECOVERY_POLL_MS);
    let deferred = false;
    await Promise.all(
      batch.map(async ({ entry, generation, revision }) => {
        try {
          await Promise.race([
            entry.refresh(controller.signal),
            new Promise<never>((_, reject) => {
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error("Refresh aborted")),
                { once: true },
              );
            }),
          ]);
          if (
            entries.get(entry.key) !== entry ||
            generation !== entry.generation ||
            revision !== entry.revision ||
            flight !== controller
          )
            return;
          entry.synced = true;
          entry.refreshFailed = false;
          if (entry.interrupted)
            report({
              event: "refresh_succeeded",
              role: entry.role,
              reason: "none",
              duration_ms: 0,
            });
          if (entry.subscribed) {
            entry.interrupted = false;
            entry.retries = 0;
          }
        } catch (error) {
          if (
            entries.get(entry.key) !== entry ||
            generation !== entry.generation ||
            revision !== entry.revision ||
            flight !== controller
          )
            return;
          if (error instanceof RecoveryDeferredError) {
            deferred = true;
            return;
          }
          interrupt(entry);
          entry.synced = false;
          entry.refreshFailed = true;
          report({ event: "refresh_failed", role: entry.role, reason: "refresh", duration_ms: 0 });
        }
      }),
    );
    clearTimeout(timeout);
    if (flight !== controller) return;
    flight = null;
    const unhealthy = [...entries.values()].some((entry) => !entry.subscribed || !entry.synced);
    pollAt = deferred ? Date.now() + 1_000 : unhealthy ? Date.now() + RECOVERY_POLL_MS : null;
    publish();
    if (pendingRefresh) requestRefresh();
    schedule();
  }

  function resume() {
    if (!online()) {
      // Offline can precede (or entirely replace) the SDK's failure callback.
      // Invalidate old acknowledgements and reads; replace only these channels
      // once visible and online, then require a fresh acknowledgement + catch-up.
      for (const entry of entries.values()) {
        interrupt(entry);
        entry.generation++;
        entry.subscribed = false;
        entry.synced = false;
        entry.retryAt = Date.now();
      }
      flight?.abort();
      flight = null;
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    publish();
    if (available()) requestRefresh();
    schedule();
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initialSnapshot,
    register(source: RecoverySource) {
      const entry: Entry = {
        ...source,
        generation: 0,
        revision: 0,
        closed: false,
        subscribed: false,
        synced: false,
        interrupted: false,
        refreshFailed: false,
        retryAt: null,
        retries: 0,
      };
      const previous = entries.get(source.key);
      if (previous) {
        previous.generation++;
        previous.cleanup?.();
      }
      entries.set(source.key, entry);
      connect(entry);
      return () => {
        if (entries.get(entry.key) !== entry) return;
        entries.delete(entry.key);
        entry.generation++;
        entry.cleanup?.();
        publish();
        schedule();
      };
    },
    retry() {
      if (!available() || flight || refreshTimer !== undefined) return;
      for (const entry of entries.values()) if (!entry.subscribed) connect(entry);
      requestRefresh();
    },
    attach() {
      window.addEventListener("online", resume);
      window.addEventListener("offline", resume);
      document.addEventListener("visibilitychange", resume);
      publish();
      schedule();
      return () => {
        window.removeEventListener("online", resume);
        window.removeEventListener("offline", resume);
        document.removeEventListener("visibilitychange", resume);
        clearTimeout(timer);
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
        flight?.abort();
        flight = null;
      };
    },
  };
}

function failureCategory(status: string, error: unknown): RecoveryDiagnostic["reason"] {
  // Never send raw SDK errors (which can contain tokens or row/filter data).
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/jwt|token|unauthoriz/i.test(message)) return "auth";
  if (/rate|too.many|limit/i.test(message)) return "limit";
  return status === "CLOSED" ? "closed" : status === "TIMED_OUT" ? "timeout" : "channel";
}

export type RealtimeRecovery = ReturnType<typeof createRealtimeRecovery>;
