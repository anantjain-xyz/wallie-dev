import { z } from "zod";

export type SandboxCapabilityName =
  | "git"
  | "node"
  | "packageManager"
  | "agentCli"
  | "playwrightPackage"
  | "chromium"
  | "screenshotSmoke";

export type SandboxCapabilityResult = {
  detail: string | null;
  ok: boolean;
};

export type SandboxCapabilityReport = Record<SandboxCapabilityName, SandboxCapabilityResult>;

export type SandboxCapabilityCheckState = {
  capabilities: Partial<SandboxCapabilityReport>;
  checkedAt: string;
  errorText: string | null;
  githubRepositoryId: string | null;
  id: string | null;
  status: "running" | "success" | "error";
};

export type SandboxCapabilityCheckResponse = {
  check: SandboxCapabilityCheckState;
};

export const sandboxCapabilityCheckRequestSchema = z.object({
  repositoryId: z.string().uuid("Repository id is invalid.").optional(),
});
