import { z } from "zod";

export type SandboxCapabilityName =
  | "git"
  | "node"
  | "packageManager"
  | "agentCli"
  | "codexExternalSandbox"
  | "playwrightPackage"
  | "chromium"
  | "screenshotSmoke";

export type SandboxCapabilityResult = {
  detail: string | null;
  ok: boolean;
};

export type SandboxCapabilityReport = Record<SandboxCapabilityName, SandboxCapabilityResult>;

export type SandboxCapabilityCheckState = {
  agentModel?: string | null;
  agentProvider?: string | null;
  capabilities: Partial<SandboxCapabilityReport>;
  checkedAt: string;
  errorText: string | null;
  githubRepositoryId: string | null;
  id: string | null;
  sandboxConnectionRevision?: string | null;
  sandboxProvider: "vercel" | "e2b" | "daytona" | "fake" | null;
  sandboxVercelProjectId: string | null;
  sandboxVercelTeamId: string | null;
  status: "running" | "success" | "error";
};

export type SandboxCapabilityCheckResponse = {
  check: SandboxCapabilityCheckState;
};

export type SandboxCapabilityCheckLatestResponse = {
  check: SandboxCapabilityCheckState | null;
};

export const sandboxCapabilityCheckRequestSchema = z.object({
  repositoryId: z.string().uuid("Repository id is invalid.").optional(),
});
