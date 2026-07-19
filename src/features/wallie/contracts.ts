import { z } from "zod";

import type { WallieActionErrorCode, WallieRun, WallieRunPage } from "@/features/wallie/types";

const workspaceIdSchema = z.string().uuid("Workspace id is invalid.");
const sessionIdSchema = z.string().uuid("Session id is invalid.");
const runIdSchema = z.string().uuid("Run id is invalid.");

export const runHistoryParamsSchema = z.object({
  sessionId: sessionIdSchema,
});

export const runHistoryQuerySchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }).optional(),
    id: runIdSchema.optional(),
  })
  .refine((value) => Boolean(value.createdAt) === Boolean(value.id), {
    message: "Run history cursor requires both createdAt and id.",
  });

export const enqueueAgentRunSchema = z.object({
  sessionId: sessionIdSchema,
  workspaceId: workspaceIdSchema,
});

export const retryAgentRunSchema = z.object({
  workspaceId: workspaceIdSchema,
});

export const retryAgentRunParamsSchema = z.object({
  runId: runIdSchema,
});

export const cancelAgentRunSchema = z.object({
  workspaceId: workspaceIdSchema,
});

export const cancelAgentRunParamsSchema = z.object({
  runId: runIdSchema,
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

export type AgentRunCancelResponse = {
  canceled: boolean;
  run: WallieRun;
};

export type RunHistoryResponse = WallieRunPage;

export type RunHistoryErrorResponse = {
  error: string;
};
