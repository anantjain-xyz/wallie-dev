"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadSupabaseBrowserClient,
  subscribeDeferredAuthenticatedChannel,
} from "@/lib/supabase/deferred-browser";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";
import { useRealtimeRecovery } from "@/features/wallie/realtime-recovery-context";

export type ApprovalReview = { reviewRevision: number; blockingCount: number };

/** Approval is disabled until the reviewer sees an authoritative, bounded summary. */
export function useApprovalReview(sessionId: string | undefined, artifactId: string | undefined) {
  const config = useSupabasePublicConfig();
  const { recovery } = useRealtimeRecovery();
  const [state, setState] = useState<{
    key: string;
    value: ApprovalReview | null;
    error: string | null;
  } | null>(null);
  const sequence = useRef(0);
  const key = `${sessionId}:${artifactId}`;
  const invalidate = useCallback(() => {
    sequence.current += 1;
  }, []);
  const refresh = useCallback(async () => {
    if (!sessionId || !artifactId) return;
    const request = ++sequence.current;
    setState({ key, value: null, error: null });
    try {
      const response = await fetch(`/api/sessions/${sessionId}/approval-review`, {
        cache: "no-store",
      });
      const value = (await response.json()) as ApprovalReview;
      if (
        !response.ok ||
        !Number.isSafeInteger(value.reviewRevision) ||
        value.reviewRevision < 0 ||
        !Number.isSafeInteger(value.blockingCount) ||
        value.blockingCount < 0
      )
        throw new Error("Review state unavailable.");
      if (request === sequence.current) setState({ key, value, error: null });
    } catch {
      if (request === sequence.current)
        setState({
          key,
          value: null,
          error: "Could not confirm blocking requests. Refresh review before approving.",
        });
    }
  }, [artifactId, key, sessionId]);
  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      invalidate();
      window.removeEventListener("focus", refresh);
    };
  }, [invalidate, refresh]);
  useEffect(() => {
    if (!config || !sessionId || !artifactId) return;
    return recovery.register({
      key: `approval-review:${sessionId}:${artifactId}`,
      role: "session",
      required: false,
      refresh: () => refresh(),
      subscribe: (onStatus, isCurrent) =>
        subscribeDeferredAuthenticatedChannel(
          () => loadSupabaseBrowserClient(config),
          (supabase) =>
            supabase.channel(`approval-review:${sessionId}:${artifactId}`).on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "artifact_review_threads",
                filter: `session_id=eq.${sessionId}`,
              },
              () => {
                if (isCurrent()) void refresh();
              },
            ),
          onStatus,
          isCurrent,
        ),
    });
  }, [artifactId, config, recovery, refresh, sessionId]);
  return {
    value: state?.key === key ? state.value : null,
    error: state?.key === key ? state.error : null,
    refresh,
  };
}
