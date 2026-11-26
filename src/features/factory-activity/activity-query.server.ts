import "server-only";

import { z } from "zod";

import {
  ACTIVITY_CURSOR_PARAM,
  type ActivityKind,
  type ActivityQuery,
} from "@/features/factory-activity/activity-query";
import { Constants } from "@/lib/supabase/database.types";

export const activityIdQuery = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
export const activityFactoryQuery = z.union([z.literal("all"), activityIdQuery]).default("all");
export const activityStatusQuery = z.enum(Constants.public.Enums.agent_run_status).optional();

const positionSchema = z.object({
  id: activityIdQuery,
  time: z.string().datetime({ offset: true }),
});
const cursorSchema = positionSchema.extend({ scope: z.string() });
const tokenSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export type ActivityPosition = z.infer<typeof positionSchema>;

function cursorScope(workspaceId: string, kind: ActivityKind, query: ActivityQuery) {
  return [workspaceId, kind, query.factory, query.actor, kind === "runs" ? query.status : ""].join(
    ":",
  );
}

export function readActivityCursor(
  value: string | string[] | undefined,
  workspaceId: string,
  kind: ActivityKind,
  query: ActivityQuery,
): ActivityPosition | undefined {
  if (!tokenSchema.safeParse(value).success || typeof value !== "string") return;
  try {
    const { scope, id, time } = cursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    if (scope === cursorScope(workspaceId, kind, query)) return { id, time };
  } catch {
    return;
  }
}

export function olderActivityQuery(
  query: ActivityQuery,
  workspaceId: string,
  kind: ActivityKind,
  position: ActivityPosition,
): ActivityQuery {
  const cursor = { ...position, scope: cursorScope(workspaceId, kind, query) };
  return {
    ...query,
    [ACTIVITY_CURSOR_PARAM[kind]]: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
  };
}
