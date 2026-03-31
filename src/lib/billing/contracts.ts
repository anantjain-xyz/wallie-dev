import { z } from "zod";

export const createStripePortalSessionSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type CreateStripePortalSessionResponse = {
  url: string;
};
