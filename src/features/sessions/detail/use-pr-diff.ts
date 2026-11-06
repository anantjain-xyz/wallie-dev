"use client";

import { useCallback, useRef, useState } from "react";

import { prDiffResponseSchema, type PrDiff } from "./review-evidence-contracts";

export function usePrDiff(sessionId: string | undefined) {
  const [state, setState] = useState<{
    value: PrDiff | null;
    error: string | null;
    loading: boolean;
  }>({ value: null, error: null, loading: false });
  const sequence = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) return null;
    const request = ++sequence.current;
    setState((current) => ({ ...current, error: null, loading: true }));
    try {
      const response = await fetch(`/api/sessions/${sessionId}/review-evidence/diff`, {
        cache: "no-store",
      });
      const parsed = prDiffResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error("Pull request diff unavailable.");
      if (request !== sequence.current) return null;
      setState({ value: parsed.data.diff, error: null, loading: false });
      return parsed.data.diff;
    } catch {
      if (request === sequence.current)
        setState((current) => ({
          ...current,
          error: "Code changes could not be loaded from GitHub. Retry or open the pull request.",
          loading: false,
        }));
      return null;
    }
  }, [sessionId]);

  return {
    value: state.value,
    error: state.error,
    loading: state.loading,
    refresh: load,
  };
}
