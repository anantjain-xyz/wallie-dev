import "server-only";

import { z } from "zod/v4";

export const linearInstant = z.iso.datetime({ offset: true });

export const linearStateSpan = z.object({
  id: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[^\s\p{Cc}]+$/u),
  stateId: z.uuid().toLowerCase(),
  startedAt: linearInstant,
  endedAt: linearInstant.nullable(),
});

export function currentLinearStateSpan(
  history: z.output<typeof linearStateSpan>[],
  stateId: string,
  issueUpdatedAt: string,
) {
  const last = history.at(-1);
  if (
    !last ||
    last.endedAt !== null ||
    last.stateId !== stateId ||
    Date.parse(last.startedAt) > Date.parse(issueUpdatedAt) ||
    history.filter((span) => span.endedAt === null).length !== 1
  ) {
    return null;
  }
  return last;
}
