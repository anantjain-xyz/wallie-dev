import { z } from "zod";

export const vercelSandboxConnectionStatusSchema = z.enum(["connected", "error"]);

const vercelIdSchema = z
  .string()
  .trim()
  .min(1, "Vercel id is required.")
  .max(128, "Vercel ids must stay under 128 characters.");

export const upsertVercelSandboxConnectionSchema = z.object({
  projectId: vercelIdSchema,
  teamId: vercelIdSchema,
  token: z.string().trim().min(1, "Vercel token is required.").max(4000),
});

export type VercelSandboxConnectionStatus = z.infer<typeof vercelSandboxConnectionStatusSchema>;

export type VercelSandboxCredentials = {
  projectId: string;
  teamId: string;
  token: string;
};

export type VercelSandboxConnectionPreview = {
  connectionRevision?: string;
  lastValidatedAt: string | null;
  lastValidationError: string | null;
  projectId: string;
  projectName: string | null;
  status: VercelSandboxConnectionStatus;
  teamId: string;
  tokenPreview: string | null;
  updatedAt: string;
  workspaceId: string;
};

export type VercelSandboxConnectionResponse = {
  connection: VercelSandboxConnectionPreview | null;
};
