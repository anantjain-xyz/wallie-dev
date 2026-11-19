import "server-only";

import { z } from "zod/v4";

import { factoryReadCursorTokenSchema } from "./contracts";

const uuid = z.uuid();
const maxDatabaseInteger = 2_147_483_647;
const scopeSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: uuid,
  factoryId: uuid,
});

export const sessionCursorKeySchema = z.object({
  number: z.number().int().positive().max(maxDatabaseInteger),
});
export const runCursorKeySchema = z.object({
  // Keep the original ISO timestamp at database precision. Zod checks the
  // calendar, then the pattern excludes year zero and bounds the numeric offset.
  createdAt: z.iso
    .datetime({ offset: true })
    .regex(
      /^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/,
    ),
  id: uuid,
});
export const conversationCursorKeySchema = z.object({
  sequence: z.number().int().nonnegative().max(maxDatabaseInteger),
});

const cursorSchema = z.discriminatedUnion("kind", [
  scopeSchema.extend({ kind: z.literal("sessions"), key: sessionCursorKeySchema }),
  scopeSchema.extend({
    kind: z.literal("runs"),
    sessionId: uuid.optional(),
    key: runCursorKeySchema,
  }),
  scopeSchema.extend({
    kind: z.literal("conversation"),
    sessionId: uuid,
    key: conversationCursorKeySchema,
  }),
]);

type FactoryReadCursor = z.infer<typeof cursorSchema>;
export type FactoryReadCursorScope = FactoryReadCursor extends infer Cursor
  ? Cursor extends FactoryReadCursor
    ? Omit<Cursor, "version" | "key">
    : never
  : never;

export function encodeFactoryReadCursor(cursor: FactoryReadCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeFactoryReadCursor(raw: string, scope: FactoryReadCursorScope) {
  if (!factoryReadCursorTokenSchema.safeParse(raw).success) return null;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) return null;
    const parsed = cursorSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) return null;
    const cursor = parsed.data;
    if (
      cursor.kind !== scope.kind ||
      cursor.workspaceId !== scope.workspaceId ||
      cursor.factoryId !== scope.factoryId
    )
      return null;
    const sessionId = "sessionId" in scope ? scope.sessionId : undefined;
    const cursorSessionId = "sessionId" in cursor ? cursor.sessionId : undefined;
    return cursorSessionId === sessionId ? cursor : null;
  } catch {
    return null;
  }
}
