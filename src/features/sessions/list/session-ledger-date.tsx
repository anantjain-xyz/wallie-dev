"use client";

import { useSyncExternalStore } from "react";

import { formatLocalizedTimestamp, formatUtcTimestamp } from "@/components/shared/time-format";

const formatDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const subscribe = () => () => {};

export function SessionLedgerDate({ value }: { value: string }) {
  const localized = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  return (
    <time
      aria-label={localized ? formatLocalizedTimestamp(value) : formatUtcTimestamp(value)}
      dateTime={value}
    >
      {localized
        ? formatDate.format(Date.parse(value))
        : new Date(value).toISOString().slice(0, 10)}
    </time>
  );
}
