import "server-only";

import { ShimmerText } from "@/components/shared/shimmer-text";
import { SessionActivityFailure } from "@/features/sessions/detail/session-activity-failure";
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
    <div aria-label="Loading run activity" className="py-3 text-sm text-muted" role="status">
      <ShimmerText>Loading activity…</ShimmerText>
    </div>
  );
}
