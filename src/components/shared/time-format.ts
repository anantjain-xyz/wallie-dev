const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const localizedShortFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

const localizedFullFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZoneName: "short",
  year: "numeric",
});

export function timestampMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatUtcTimestamp(value: string) {
  const parsed = timestampMs(value);
  if (parsed === null) return "Unknown time";

  return `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatLocalizedTimestamp(
  value: string,
  options: {
    locale?: string;
    style?: "full" | "short";
    timeZone?: string;
  } = {},
) {
  const parsed = timestampMs(value);
  if (parsed === null) return "Unknown time";

  const style = options.style ?? "full";
  const formatter =
    options.locale || options.timeZone
      ? new Intl.DateTimeFormat(options.locale, {
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          month: "short",
          ...(style === "full" ? { timeZoneName: "short", year: "numeric" } : {}),
          timeZone: options.timeZone,
        })
      : style === "short"
        ? localizedShortFormatter
        : localizedFullFormatter;

  return formatter.format(parsed);
}

export function formatRelativeTimestamp(value: string, now: string | number) {
  const thenMs = timestampMs(value);
  const nowMs = typeof now === "number" ? now : timestampMs(now);
  if (thenMs === null || nowMs === null) return "recently";

  const ageMs = Math.max(0, nowMs - thenMs);
  if (ageMs < MINUTE_MS) return "just now";
  if (ageMs < HOUR_MS) return `${Math.floor(ageMs / MINUTE_MS)}m ago`;
  if (ageMs < DAY_MS) return `${Math.floor(ageMs / HOUR_MS)}h ago`;
  return `${Math.floor(ageMs / DAY_MS)}d ago`;
}

export function nextRelativeUpdateDelay(value: string, nowMs: number) {
  const thenMs = timestampMs(value);
  if (thenMs === null) return null;

  const ageMs = Math.max(0, nowMs - thenMs);
  const unitMs = ageMs < HOUR_MS ? MINUTE_MS : ageMs < DAY_MS ? HOUR_MS : DAY_MS;
  const nextBoundaryMs = thenMs + (Math.floor(ageMs / unitMs) + 1) * unitMs;
  return Math.max(1, nextBoundaryMs - nowMs);
}

export function formatElapsed(startValue: string, endMs: number) {
  const startMs = timestampMs(startValue);
  if (startMs === null) return "—";

  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function nextElapsedUpdateDelay(startValue: string, nowMs: number) {
  const startMs = timestampMs(startValue);
  if (startMs === null) return null;

  const elapsedMs = Math.max(0, nowMs - startMs);
  return 1000 - (elapsedMs % 1000);
}

export { DAY_MS, HOUR_MS, MINUTE_MS };
