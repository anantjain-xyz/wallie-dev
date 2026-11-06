"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useRealtimeRecovery } from "@/features/wallie/realtime-recovery-context";
import {
  loadSupabaseBrowserClient,
  subscribeDeferredAuthenticatedChannel,
} from "@/lib/supabase/deferred-browser";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";
import {
  reviewEvidenceResponseSchema,
  type ReviewEvidenceDelivery,
} from "./review-evidence-contracts";

export function useReviewEvidence(sessionId: string | undefined) {
  const config = useSupabasePublicConfig();
  const { recovery } = useRealtimeRecovery();
  const [state, setState] = useState<{
    value: ReviewEvidenceDelivery | null;
    error: string | null;
    loading: boolean;
  }>({ value: null, error: null, loading: Boolean(sessionId) });
  const sequence = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) return null;
    const request = ++sequence.current;
    setState((current) => ({ ...current, error: null, loading: true }));
    try {
      const response = await fetch(`/api/sessions/${sessionId}/review-evidence`, {
        cache: "no-store",
      });
      const parsed = reviewEvidenceResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("Delivery evidence unavailable.");
      if (request !== sequence.current) return null;
      setState({ value: parsed.data.delivery, error: null, loading: false });
      return parsed.data.delivery;
    } catch {
      if (request === sequence.current)
        setState((current) => ({
          ...current,
          error: "Delivery evidence is unavailable. Retry to confirm readiness.",
          loading: false,
        }));
      return null;
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      sequence.current += 1;
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  // Re-read when the observation ages out of the configured freshness window.
  // Expired evidence must stop presenting as current without waiting for focus.
  useEffect(() => {
    const observedAt = state.value?.pr?.observedAt;
    const freshnessSeconds = state.value?.requirements.freshnessSeconds;
    if (!observedAt || !freshnessSeconds) return;
    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs)) return;
    const delay = observedMs + freshnessSeconds * 1000 - Date.now() + 1_000;
    if (delay <= 0 || delay > 2_147_483_647) return;
    const timer = window.setTimeout(() => void load(), delay);
    return () => window.clearTimeout(timer);
  }, [load, state.value?.pr?.observedAt, state.value?.requirements.freshnessSeconds]);

  // Thread, queue, and observation writes all change the server-owned answer.
  useEffect(() => {
    if (!config || !sessionId) return;
    return recovery.register({
      key: `review-evidence:${sessionId}`,
      role: "session",
      required: false,
      refresh: async () => {
        await load();
      },
      subscribe: (onStatus, isCurrent) =>
        subscribeDeferredAuthenticatedChannel(
          () => loadSupabaseBrowserClient(config),
          (supabase) =>
            supabase
              .channel(`review-evidence:${sessionId}`)
              .on(
                "postgres_changes",
                {
                  event: "*",
                  schema: "public",
                  table: "artifact_review_threads",
                  filter: `session_id=eq.${sessionId}`,
                },
                () => {
                  if (isCurrent()) void load();
                },
              )
              .on(
                "postgres_changes",
                {
                  event: "*",
                  schema: "public",
                  table: "session_pr_refresh_queue",
                  filter: `session_id=eq.${sessionId}`,
                },
                () => {
                  if (isCurrent()) void load();
                },
              )
              .on(
                "postgres_changes",
                {
                  event: "*",
                  schema: "public",
                  table: "session_pr_verification_observations",
                  filter: `session_id=eq.${sessionId}`,
                },
                () => {
                  if (isCurrent()) void load();
                },
              ),
          onStatus,
          isCurrent,
        ),
    });
  }, [config, load, recovery, sessionId]);

  return {
    value: state.value,
    error: state.error,
    loading: state.loading,
    refresh: load,
  };
}
