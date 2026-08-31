import "server-only";

import { SessionActivityPanel } from "@/features/sessions/detail/session-activity-client";
import { loadWallieSessionData } from "@/features/wallie/server";
import type { WallieSessionData } from "@/features/wallie/types";
import type { SessionActivityContext } from "@/features/sessions/detail/data";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";

type SessionActivityProps = {
  archivedAt: string | null;
  context: SessionActivityContext;
  initialNow: string;
  workspaceSlug: string;
};

export async function SessionActivity({
  archivedAt,
  context,
  initialNow,
  workspaceSlug,
}: SessionActivityProps) {
  let data: WallieSessionData | null = null;

  try {
    data = await withServerTiming(
      "sessions.detail.activity",
      { sessionId: context.sessionId, workspaceSlug },
      async (timing) => {
        const supabase = await createSupabaseServerClient();

        return timing.segment(
          "wallie-summary",
          () =>
            loadWallieSessionData({
              repository: context.repository,
              session: {
                githubRepositoryId: context.sessionGithubRepositoryId,
                id: context.sessionId,
              },
              supabase,
              workspaceId: context.workspaceId,
            }),
          (wallieData) => ({
            payloadBytes: approximatePayloadSizeBytes(wallieData),
            runs: wallieData.runs.length,
          }),
        );
      },
    );
  } catch (error) {
    console.error("Wallie activity could not load", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: context.sessionId,
    });
  }

  if (!data) return <SessionActivityFailure />;

  return (
    <SessionActivityPanel
      initialArchivedAt={archivedAt}
      initialData={data}
      initialNow={initialNow}
      sessionId={context.sessionId}
      workspaceId={context.workspaceId}
      workspaceSlug={workspaceSlug}
    />
  );
}

export function SessionActivityFallback() {
  return (
    <div aria-label="Loading run activity" className="space-y-2" role="status">
      <div className="h-4 w-40 animate-pulse rounded bg-control-muted" />
      <div className="h-12 animate-pulse rounded border border-border bg-control-muted" />
    </div>
  );
}

export function SessionActivityFailure() {
  return (
    <div className="rounded-[4px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning">
      Run activity is temporarily unavailable. Session review is still available.
    </div>
  );
}
