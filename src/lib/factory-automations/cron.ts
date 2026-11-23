const cronSegment = /^(\*|[0-9]+)(?:-([0-9]+))?(?:\/([0-9]+))?$/;

type CronSegment = { start: number; end: number; step: number; wildcard: boolean };

function parseField(field: string, min: number, max: number): CronSegment[] | null {
  const segments: CronSegment[] = [];
  for (const part of field.split(",")) {
    const match = cronSegment.exec(part);
    if (!match) return null;
    const [, anchor, last, stride] = match;
    const wildcard = anchor === "*";
    if (
      (wildcard && last !== undefined) ||
      (!wildcard && last === undefined && stride !== undefined)
    ) {
      return null;
    }

    const start = wildcard ? min : Number(anchor);
    const end = wildcard ? max : Number(last ?? anchor);
    const step = Number(stride ?? "1");
    if (start < min || end > max || end < start || step < 1) return null;
    segments.push({ start, end, step, wildcard });
  }
  return segments;
}

export function parseFactoryAutomationCron(expression: string) {
  if (expression.length > 120) return null;
  const fields = expression.split(" ");
  if (fields.length !== 5) return null;
  const [minuteText, hourText, dayOfMonthText, monthText, dayOfWeekText] = fields;
  const minute = parseField(minuteText, 0, 59);
  const hour = parseField(hourText, 0, 23);
  const dayOfMonth = parseField(dayOfMonthText, 1, 31);
  const month = parseField(monthText, 1, 12);
  const dayOfWeek = parseField(dayOfWeekText, 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}
