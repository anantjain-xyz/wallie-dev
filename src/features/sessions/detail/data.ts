import "server-only";

import { notFound } from "next/navigation";

import type { WorkspaceSummary } from "@/lib/auth";
import { loadSessionWorkspaceContext } from "@/features/sessions/server";
import type { SessionDetail } from "@/features/sessions/types";
import { loadWallieSessionData } from "@/features/wallie/server";
import type { WallieSessionData, WallieSessionRepository } from "@/features/wallie/types";
import type { WorkspaceMember } from "@/features/workspace-members/types";
import {
  approximatePayloadSizeBytes,
  type ServerTimingCollector,
  withServerTiming,
} from "@/lib/server-timing";

export type SessionDetailPageData = {
  currentMember: WorkspaceMember | null;
  members: WorkspaceMember[];
  memberIndex: ReadonlyMap<string, WorkspaceMember>;
  session: SessionDetail;
  sessionGithubRepositoryId: string | null;
  sessionCreator: WorkspaceMember | null;
  wallie: WallieSessionData;
  workspace: WorkspaceSummary;
};

type SessionDetailRpcPayload = {
  creatorMemberId?: string | null;
  repository?: WallieSessionRepository | null;
  session?: SessionDetail;
  sessionGithubRepositoryId?: string | null;
};

export async function loadSessionDetailPageData(
  workspaceSlug: string,
  sessionNumberValue: string,
): Promise<SessionDetailPageData> {
  const sessionNumber = Number(sessionNumberValue);
  if (!Number.isInteger(sessionNumber) || sessionNumber < 1) {
    notFound();
  }

  return withServerTiming(
    "sessions.detail",
    {
      sessionNumber,
      workspaceSlug,
    },
    (timing) => loadSessionDetailPageDataWithTiming(workspaceSlug, sessionNumber, timing),
  );
}

async function loadSessionDetailPageDataWithTiming(
  workspaceSlug: string,
  sessionNumber: number,
  timing: ServerTimingCollector,
): Promise<SessionDetailPageData> {
  const context = await timing.segment(
    "workspace-member-context",
    () => loadSessionWorkspaceContext(workspaceSlug),
    (resolvedContext) => ({
      members: resolvedContext.members.length,
      payloadBytes: approximatePayloadSizeBytes({
        currentMember: resolvedContext.currentMember,
        members: resolvedContext.members,
        workspace: resolvedContext.workspace,
      }),
      rows: 1,
    }),
  );

  const { data: rpcData, error: rpcError } = await timing.segment(
    "session-detail-rpc",
    () =>
      context.supabase.rpc("get_session_detail_page", {
        target_session_number: sessionNumber,
        target_workspace_slug: workspaceSlug,
      }),
    (result) => ({
      payloadBytes: approximatePayloadSizeBytes(result.data),
      rows: result.data ? 1 : 0,
    }),
  );

  if (rpcError) throw rpcError;
  if (!rpcData) notFound();

  const payload = rpcData as SessionDetailRpcPayload;
  if (!payload.session) notFound();

  const sessionGithubRepositoryId = payload.sessionGithubRepositoryId ?? null;
  const repository = payload.repository ?? null;
  const wallie = await timing.segment(
    "wallie-summary",
    () =>
      loadWallieSessionData({
        memberIndex: context.memberIndex,
        repository,
        session: { githubRepositoryId: sessionGithubRepositoryId, id: payload.session!.id },
        supabase: context.supabase,
        workspaceId: context.workspace.id,
      }),
    (wallieData) => ({
      blockingReasons: wallieData.blockingReasons.length,
      missingSecrets: wallieData.missingSecretKeys.length,
      payloadBytes: approximatePayloadSizeBytes({
        blockingReasons: wallieData.blockingReasons,
        loadedMessageRunIds: wallieData.loadedMessageRunIds,
        missingSecretKeys: wallieData.missingSecretKeys,
        repository: wallieData.repository,
        runs: wallieData.runs,
        vercelSandboxConnection: wallieData.vercelSandboxConnection,
      }),
      runs: wallieData.runs.length,
    }),
  );

  const sessionCreator = payload.creatorMemberId
    ? (context.memberIndex.get(payload.creatorMemberId) ?? null)
    : null;

  return {
    currentMember: context.currentMember,
    memberIndex: context.memberIndex,
    members: context.members,
    session: payload.session,
    sessionGithubRepositoryId,
    sessionCreator,
    wallie,
    workspace: context.workspace,
  };
}
