import { z } from "zod";

export const updateSessionTitlePayloadSchema = z.object({
  title: z.string().trim().min(1, "Title is required."),
});

export type UpdateSessionTitlePayload = z.infer<typeof updateSessionTitlePayloadSchema>;

export const updateSessionTitleClientInputSchema = updateSessionTitlePayloadSchema.extend({
  sessionId: z.string().uuid("Session id is invalid."),
});

export type UpdateSessionTitleClientInput = z.infer<typeof updateSessionTitleClientInputSchema>;

export function normalizeUpdateSessionTitlePayload(payload: UpdateSessionTitlePayload) {
  return {
    title: payload.title.trim(),
  };
}
