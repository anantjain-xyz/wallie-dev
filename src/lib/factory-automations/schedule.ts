import { parseFactoryAutomationCron } from "./cron";

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
const lookaheadMs = 8 * 366 * dayMs;

type Cron = NonNullable<ReturnType<typeof parseFactoryAutomationCron>>;

function matches(segments: Cron["minute"], value: number) {
  return segments.some(
    ({ start, end, step }) => value >= start && value <= end && (value - start) % step === 0,
  );
}

function matchesDate(cron: Cron, date: Date) {
  if (!matches(cron.month, date.getUTCMonth() + 1)) return false;
  const day = matches(cron.dayOfMonth, date.getUTCDate());
  const weekday = date.getUTCDay();
  const week = matches(cron.dayOfWeek, weekday) || (weekday === 0 && matches(cron.dayOfWeek, 7));
  return cron.dayOfMonth[0].wildcard || cron.dayOfWeek[0].wildcard ? day && week : day || week;
}

function dayStart(time: number) {
  return Math.floor(time / dayMs) * dayMs;
}

export function createFactoryAutomationSchedule(input: { cron: string; timeZone: string }) {
  const cron = parseFactoryAutomationCron(input.cron);
  if (!cron) return null;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: input.timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }

  function matchingMinutes(civilDay: number, after: number, through: number, limit: number) {
    const date = new Date(civilDay);
    if (!cron || !matchesDate(cron, date)) return [];
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const seenWallMinutes = new Set<number>();
    const instants: number[] = [];

    // Scan the complete UTC window that can map to this civil date. Observing
    // the first matching instant before checking the cursor also suppresses
    // the second side of a fold when the cursor is between the two instants.
    for (
      let instant = civilDay - dayMs;
      instant < civilDay + 2 * dayMs && instant <= through && instants.length < limit;
      instant += minuteMs
    ) {
      const parts = formatter.formatToParts(instant);
      if (
        parts.find((part) => part.type === "day")?.value !== day ||
        parts.find((part) => part.type === "month")?.value !== month ||
        parts.find((part) => part.type === "year")?.value !== year
      )
        continue;
      const hour = Number(parts.find((part) => part.type === "hour")?.value);
      const minute = Number(parts.find((part) => part.type === "minute")?.value);
      if (!matches(cron.hour, hour) || !matches(cron.minute, minute)) continue;
      const wallMinute = hour * 60 + minute;
      if (seenWallMinutes.has(wallMinute)) continue;
      seenWallMinutes.add(wallMinute);
      if (instant > after) instants.push(instant);
    }
    return instants;
  }

  function nextOccurrences(after: number, count: number) {
    const through = after + lookaheadMs;
    const found: number[] = [];
    for (let day = dayStart(after) - dayMs; day <= dayStart(through) + dayMs; day += dayMs) {
      if (found.length === count && day - dayMs > found[count - 1]) break;
      found.push(...matchingMinutes(day, after, through, count));
      found.sort((left, right) => left - right);
      found.splice(count);
    }
    return found;
  }

  function latestDueOccurrence(scannedThrough: number, through: number) {
    const after = Math.max(scannedThrough, through - dayMs);
    if (after >= through) return null;
    let latest: number | null = null;
    for (let day = dayStart(through) + dayMs; day >= dayStart(after) - dayMs; day -= dayMs) {
      if (latest !== null && day + 2 * dayMs <= latest) break;
      const matching = matchingMinutes(day, after, through, 24 * 60).at(-1);
      if (matching !== undefined && (latest === null || matching > latest)) latest = matching;
    }
    return latest;
  }

  return { nextOccurrences, latestDueOccurrence };
}
