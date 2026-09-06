import { isProductionTelemetryEnabled } from "./environment";

export type RecoveryDiagnostic = {
  event: "subscription_failed" | "refresh_failed" | "refresh_succeeded" | "recovered";
  role: "page" | "session" | "runs" | "messages" | "history";
  reason: "none" | "auth" | "limit" | "closed" | "timeout" | "channel" | "refresh";
  duration_ms: number;
};

export function recordRealtimeRecovery(event: RecoveryDiagnostic) {
  if (!isProductionTelemetryEnabled()) return;
  void import("@vercel/analytics")
    .then(({ track }) => {
      track("wallie_realtime_recovery", {
        ...event,
        duration_ms: Math.min(3_600_000, Math.max(0, event.duration_ms)),
      });
    })
    .catch(() => {
      /* Diagnostics must not interfere with recovery. */
    });
}
