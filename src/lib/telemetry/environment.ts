export const PRODUCTION_TELEMETRY_MARKER_ID = "wallie-production-telemetry-enabled";

type TelemetryMarkerRoot = Pick<Document, "getElementById">;

export function isProductionTelemetryEnabled(
  root: TelemetryMarkerRoot | null = typeof document === "undefined" ? null : document,
) {
  return Boolean(root?.getElementById(PRODUCTION_TELEMETRY_MARKER_ID));
}
