import { z } from "zod";

export const workspaceSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1, "Workspace name is required.").max(80),
  slug: z
    .string()
    .trim()
    .max(63, "Workspace slugs must stay under 64 characters.")
    .regex(workspaceSlugPattern, "Use lowercase letters, numbers, and single hyphens only.")
    .optional()
    .or(z.literal("")),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export function normalizeWorkspaceSlug(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();

  return normalized ? normalized : undefined;
}

export function slugifyWorkspaceName(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "workspace";
}
