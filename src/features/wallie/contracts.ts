import { z } from "zod";

import type { WallieRun } from "@/features/wallie/types";
import type { WallieActionErrorCode } from "@/lib/wallie/types";

const workspaceIdSchema = z.string().uuid("Workspace id is invalid.");
const issueIdSchema = z.string().uuid("Issue id is invalid.");
const jobIdSchema = z.string().uuid("Job id is invalid.");
const runIdSchema = z.string().uuid("Run id is invalid.");

export const enqueueAgentRunSchema = z.object({
  issueId: issueIdSchema,
  workspaceId: workspaceIdSchema,
});

export const retryAgentRunSchema = z.object({
  workspaceId: workspaceIdSchema,
});

export const retryAgentRunParamsSchema = z.object({
  runId: runIdSchema,
});

export const processAgentJobsSchema = z.object({
  jobId: jobIdSchema.optional(),
  workspaceId: workspaceIdSchema.optional(),
});

export type AgentRunActionResponse = {
  code?: "active_run";
  created: boolean;
  processScheduled: boolean;
  run: WallieRun;
};

export type AgentRunActionErrorResponse = {
  code: WallieActionErrorCode;
  error: string;
  missingSecretKeys?: string[];
};

export type ProcessAgentJobsResponse = {
  jobId: string | null;
  processed: boolean;
  result: "error" | "idle" | "success";
  runId: string | null;
};
