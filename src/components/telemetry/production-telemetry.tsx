"use client";

import type { BeforeSendEvent as AnalyticsEvent } from "@vercel/analytics/next";
import dynamic from "next/dynamic";

import { routeTemplateForPath, sanitizeTelemetryUrl } from "@/lib/telemetry/privacy";

const Analytics = dynamic(
  () => import("@vercel/analytics/next").then((module) => module.Analytics),
  { ssr: false },
);
const SpeedInsights = dynamic(
  () => import("@vercel/speed-insights/next").then((module) => module.SpeedInsights),
  { ssr: false },
);

export function ProductionTelemetry() {
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
