"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  loadSupabaseBrowserClient,
  subscribeDeferredAuthenticatedChannel,
} from "@/lib/supabase/deferred-browser";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";
import { useRealtimeRecovery } from "@/features/wallie/realtime-recovery-context";
import { blockingReviewTargetSchema, type BlockingReviewTarget } from "./blocking-review-target";

export type ApprovalReviewDelivery = {
  required: boolean;
  state: "unknown" | "checking" | "blocked" | "ready" | "merged" | "closed";
  blockers: Array<{ code: string; requirement?: string }>;
};

export type ApprovalReview = {
  reviewRevision: number;
  blockingCount: number;
  blockingTarget?: BlockingReviewTarget | null;
  delivery?: ApprovalReviewDelivery | null;
};

const approvalDeliverySchema = z.object({
  required: z.boolean(),
  state: z.enum(["unknown", "checking", "blocked", "ready", "merged", "closed"]),
  blockers: z
    .array(
      z.object({
        code: z.string().min(1).max(200),
        requirement: z.string().min(1).max(200).optional(),
      }),
    )
    .max(64),
});

const approvalReviewSchema = z
  .object({
    reviewRevision: z.number().int().nonnegative(),
    blockingCount: z.number().int().nonnegative(),
    blockingTarget: blockingReviewTargetSchema.nullable().optional(),
    delivery: approvalDeliverySchema.nullable().optional(),
  })
  .strict();

/** Approval is disabled until the reviewer sees an authoritative, bounded summary. */
export function useApprovalReview(
  sessionId: string | undefined,
  artifactId: string | undefined,
  verificationKey?: string,
) {
  const config = useSupabasePublicConfig();
  const { recovery } = useRealtimeRecovery();
  const [state, setState] = useState<{
    key: string;
    scope: string;
    confirmedRevision: number | null;
    value: ApprovalReview | null;
    error: string | null;
  } | null>(null);
  const sequence = useRef(0);
  const target = useRef<{ key: string; scope: string; sessionId: string } | null>(null);
  const scope = `${sessionId}:${artifactId}`;
  const key = `${scope}:${verificationKey ?? ""}`;
  useLayoutEffect(() => {
    target.current = sessionId && artifactId ? { key, scope, sessionId } : null;
    return () => {
      target.current = null;
      sequence.current += 1;
    };
  }, [artifactId, key, scope, sessionId]);
  const refresh = useCallback(async () => {
    if (!target.current) return;
    const { key, scope, sessionId } = target.current;
    const request = ++sequence.current;
    setState((prev) => ({
      key,
      scope,
      confirmedRevision: prev?.scope === scope ? prev.confirmedRevision : null,
      value: null,
      error: null,
    }));
    try {
      const response = await fetch(
        `/api/sessions/${sessionId}/approval-review?include=blockingTarget`,
        { cache: "no-store" },
      );
      const parsed = approvalReviewSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("Review state unavailable.");
      const value = parsed.data;
      if (request === sequence.current)
        setState({ key, scope, confirmedRevision: value.reviewRevision, value, error: null });
    } catch {
      if (request === sequence.current)
        setState({
          key,
          scope,
          confirmedRevision: null,
          value: null,
          error: "Could not confirm review comments.",
        });
    }
  }, []);
  useEffect(() => {
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [key, refresh]);
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
    confirmedRevision: state?.scope === scope ? state.confirmedRevision : null,
    value: state?.key === key ? state.value : null,
    error: state?.key === key ? state.error : null,
    refresh,
  };
}
