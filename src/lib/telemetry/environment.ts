export function isProductionTelemetryEnabled(environment = process.env.NODE_ENV) {
  return environment === "production";
}
