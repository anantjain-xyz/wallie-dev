const REFRESH_COOLDOWN_MS = 10_000;
const EVENT_SETTLE_MS = 200;

/** Coalesce recovery signals; never poll a healthy, hidden, or offline page. */
export function createSessionRecoveryRefresh({
  refresh,
  isAvailable,
  isBusy,
}: {
  refresh: () => void;
  isAvailable: () => boolean;
  isBusy: () => boolean;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastRefreshAt = -Infinity;
  let disposed = false;
  let pending = false;
  let subscribed = false;
  let interrupted = false;

  function schedule() {
    if (disposed || !pending || timer !== undefined || !isAvailable()) return;
    const delay = Math.max(EVENT_SETTLE_MS, REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAt));
    timer = setTimeout(flush, delay);
  }

  function flush() {
    timer = undefined;
    if (disposed || !pending || !isAvailable()) return;
    if (isBusy()) {
      timer = setTimeout(flush, 1_000);
      return;
    }
    pending = false;
    lastRefreshAt = Date.now();
    refresh();
  }

  function request() {
    pending = true;
    schedule();
  }

  return {
    request,
    onStatus(status: string) {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        if (subscribed || interrupted) request();
        subscribed = true;
        interrupted = false;
      } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
        interrupted = true;
      }
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
