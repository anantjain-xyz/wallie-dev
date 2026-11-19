import { z } from "zod";

import type { Enums } from "@/lib/supabase/database.types";

export const factoryCommandLabels = {
  "sessions:read": "Read sessions",
  "sessions:create": "Create sessions",
  "sessions:follow-up": "Send follow-ups",
  "sessions:clarify": "Answer clarifications",
  "sessions:cancel": "Cancel session work",
  "deployments:observe": "Report deployment observations",
} satisfies Record<Enums<"factory_command_scope">, string>;

export const factoryCommandScopeSchema = z.enum([
  "sessions:read",
  "sessions:create",
  "sessions:follow-up",
  "sessions:clarify",
  "sessions:cancel",
  "deployments:observe",
]);

export const factoryCommandScopesSchema = z
  .array(factoryCommandScopeSchema)
  .max(factoryCommandScopeSchema.options.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "Select each scope once.");

export const factoryMachineTokenCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    grantVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((name) => !/\p{Cc}/u.test(name)),
    scopes: factoryCommandScopesSchema.refine((scopes) => scopes.length > 0),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  }),
  z.strictObject({ action: z.literal("revoke"), tokenId: z.string().uuid() }),
]);

export type FactoryMachineTokenCommand = z.output<typeof factoryMachineTokenCommandSchema>;
