import { z } from "zod";

export const updateSessionTitlePayloadSchema = z.object({
  title: z.string().trim().min(1, "Title is required."),
});

export type UpdateSessionTitlePayload = z.infer<typeof updateSessionTitlePayloadSchema>;

export function normalizeUpdateSessionTitlePayload(payload: UpdateSessionTitlePayload) {
  const parsed = updateSessionTitlePayloadSchema.parse(payload);

  return {
    title: parsed.title,
  };
}
