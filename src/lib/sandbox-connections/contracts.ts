import { z } from "zod";

import type { VercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/contracts";
import type { SandboxProvider } from "@/lib/sandbox";

export const SANDBOX_PROVIDERS = ["vercel", "e2b", "daytona"] as const;
export const sandboxProviderSchema = z.enum(SANDBOX_PROVIDERS);
export const sandboxConnectionStatusSchema = z.enum(["connected", "error"]);

export const upsertE2BSandboxConnectionSchema = z.object({
  apiKey: z.string().trim().min(1, "E2B API key is required.").max(4000),
});

export const upsertDaytonaSandboxConnectionSchema = z.object({
  apiKey: z.string().trim().min(1, "Daytona API key is required.").max(4000),
  apiUrl: z.string().trim().max(2048).optional(),
  target: z.string().trim().min(1).max(128).optional(),
});

export const updateSandboxSettingsSchema = z.object({
  activeProvider: sandboxProviderSchema,
  expectedRevision: z.number().int().positive(),
});

export type SandboxConnectionStatus = z.infer<typeof sandboxConnectionStatusSchema>;

export type E2BSandboxConnectionPreview = {
  apiKeyPreview: string | null;
  connectionRevision: string;
  lastValidatedAt: string | null;
  lastValidationError: string | null;
  status: SandboxConnectionStatus;
  updatedAt: string;
  workspaceId: string;
};

export type DaytonaSandboxConnectionPreview = E2BSandboxConnectionPreview & {
  apiUrl: string;
  target: string | null;
};

export type SandboxConnectionPreviews = {
  daytona: DaytonaSandboxConnectionPreview | null;
  e2b: E2BSandboxConnectionPreview | null;
  vercel: VercelSandboxConnectionPreview | null;
};

export type SandboxSettingsResponse = {
  activeProvider: SandboxProvider;
  connections: SandboxConnectionPreviews;
  enabledProviders: SandboxProvider[];
  revision: number;
  updatedAt: string | null;
};
