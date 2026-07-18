export const PROVIDER_STATUS_STALE_AFTER_MS = 60_000;

export function isProviderStatusStale(
  checkedAt: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!checkedAt) return true;
  const checkedAtMs = Date.parse(checkedAt);
  return !Number.isFinite(checkedAtMs) || nowMs - checkedAtMs > PROVIDER_STATUS_STALE_AFTER_MS;
}
