"use client";

import { Analytics, type BeforeSendEvent as AnalyticsEvent } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { finishVisibleNavigation } from "@/lib/telemetry/interaction-rum";
import { routeTemplateForPath, sanitizeTelemetryUrl } from "@/lib/telemetry/privacy";

export function ProductionTelemetry() {
  const pathname = usePathname();

  useEffect(() => {
    const frame = requestAnimationFrame(() => finishVisibleNavigation(pathname ?? "/"));
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  return (
    <>
      <Analytics
        mode="production"
        beforeSend={(event: AnalyticsEvent) => ({
          ...event,
          url: sanitizeTelemetryUrl(event.url),
        })}
      />
      <SpeedInsights
        beforeSend={(event) => ({
          ...event,
          route: routeTemplateForPath(new URL(event.url, window.location.origin).pathname),
          url: sanitizeTelemetryUrl(event.url),
        })}
      />
    </>
  );
}
