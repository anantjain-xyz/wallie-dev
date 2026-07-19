"use client";

import { useEffect, useState } from "react";

import {
  formatElapsed,
  formatLocalizedTimestamp,
  formatRelativeTimestamp,
  formatUtcTimestamp,
  nextElapsedUpdateDelay,
  nextRelativeUpdateDelay,
  timestampMs,
} from "@/components/shared/time-format";

export {
  formatLocalizedTimestamp,
  formatRelativeTimestamp,
  formatUtcTimestamp,
  nextRelativeUpdateDelay,
} from "@/components/shared/time-format";

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
            ? nextElapsedUpdateDelay(value, nowMs)
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
      aria-label={
        variant === "elapsed" ? `${displayLabel}, started ${absoluteLabel}` : absoluteLabel
      }
      className={className}
      data-time-display={variant}
      dateTime={value}
    >
      {displayLabel}
    </time>
  );
}
