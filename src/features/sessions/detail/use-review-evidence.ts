"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  reviewEvidenceResponseSchema,
  type ReviewEvidenceDelivery,
} from "./review-evidence-contracts";

export function useReviewEvidence(sessionId: string | undefined) {
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

  return {
    value: state.value,
    error: state.error,
    loading: state.loading,
    refresh: load,
  };
}
