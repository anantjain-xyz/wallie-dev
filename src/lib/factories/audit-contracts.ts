import { z } from "zod";

const maxEventId = "9223372036854775807";
export const factoryAuditEventIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((id) => id.length < maxEventId.length || id <= maxEventId);

export const factoryAuditSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), id: factoryAuditEventIdSchema }).strict(),
  z
    .object({
      kind: z.enum(["actor", "grant", "principal", "binding", "mcp-binding"]),
      id: z.string().uuid().toLowerCase(),
    })
    .strict(),
]);

export type FactoryAuditSource = z.infer<typeof factoryAuditSourceSchema>;

export const factoryAuditFacetSchema = z.literal("governance");
export const factoryAuditCursorTokenSchema = z
  .string()
  .max(768)
  .regex(/^[\w-]+$/);
