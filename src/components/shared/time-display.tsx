"use client";

import { useEffect, useState } from "react";

type TimeDisplayVariant = "absolute" | "elapsed" | "relative";

type TimeDisplayProps = {
  absoluteStyle?: "full" | "short";
  active?: boolean;
  className?: string;
  endValue?: string | null;
  initialNow: string;
  value: string;
  variant?: TimeDisplayVariant;
};

const MAX_TIMEOUT_MS = 2_147_483_647;
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

function timestampMs(value: string) {
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

function formatElapsed(startValue: string, endMs: number) {
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

function nextElapsedUpdateDelay(nowMs: number) {
  return 1000 - (nowMs % 1000);
}

export function TimeDisplay({
  absoluteStyle = "full",
  active = false,
  className,
  endValue,
  initialNow,
  value,
  variant = "absolute",
}: TimeDisplayProps) {
  const initialNowMs = timestampMs(initialNow) ?? 0;
  const [clientNowMs, setClientNowMs] = useState<number | null>(null);
  const hydrated = clientNowMs !== null;

  useEffect(() => {
    let timeoutId: number | undefined;

    const update = () => {
      const nowMs = Date.now();
      setClientNowMs(nowMs);

      const delay =
        variant === "relative"
          ? nextRelativeUpdateDelay(value, nowMs)
          : variant === "elapsed" && active && !endValue
            ? nextElapsedUpdateDelay(nowMs)
            : null;

      if (delay !== null) {
        timeoutId = window.setTimeout(update, Math.min(delay, MAX_TIMEOUT_MS));
      }
    };

    update();

    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [active, endValue, value, variant]);

  const absoluteLabel = hydrated
    ? formatLocalizedTimestamp(value, { style: "full" })
    : formatUtcTimestamp(value);
  let displayLabel: string;

  switch (variant) {
    case "relative":
      displayLabel = formatRelativeTimestamp(value, clientNowMs ?? initialNowMs);
      break;
    case "elapsed": {
      const endMs = endValue ? timestampMs(endValue) : null;
      displayLabel =
        endMs !== null
          ? formatElapsed(value, endMs)
          : hydrated
            ? formatElapsed(value, clientNowMs)
            : "—";
      break;
    }
    default:
      displayLabel = hydrated
        ? formatLocalizedTimestamp(value, { style: absoluteStyle })
        : formatUtcTimestamp(value);
  }

  return (
    <time
      aria-label={absoluteLabel}
      className={className}
      data-time-display={variant}
      dateTime={value}
    >
      {displayLabel}
    </time>
  );
}
