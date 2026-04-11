import { z } from "zod";

export const slackWorkspaceQuerySchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type SlackInstallationSummary = {
  id: string;
  installedAt: string;
  teamId: string;
  teamName: string | null;
  updatedAt: string;
};

export type SlackInstallResponse = {
  installUrl: string;
};

export type SlackDisconnectResponse = {
  deletedId: string;
};
