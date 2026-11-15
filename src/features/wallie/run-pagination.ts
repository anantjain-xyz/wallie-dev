import { z } from "zod";

import type { WallieRunCursor } from "@/features/wallie/types";

export const runCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

/** Run keys are immutable. Preserve the exact database timestamp, including sub-millisecond precision. */
export function olderRunFilter(cursor: WallieRunCursor): string {
  return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

export function splitRunPage<T>(
  rows: readonly T[],
  limit: number,
  cursorForRow: (row: T) => WallieRunCursor,
) {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > limit && last ? cursorForRow(last) : null };
}
