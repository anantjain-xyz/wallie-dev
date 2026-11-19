"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  browserEvidencePath,
  exactBrowserEvidenceSchema,
  type BrowserEvidenceSelection,
  type BrowserEvidenceReceipt,
} from "./browser-evidence-contracts";

function subscribeToHash(change: () => void) {
  window.addEventListener("hashchange", change);
  return () => window.removeEventListener("hashchange", change);
}

export function useBrowserEvidenceHash() {
  return useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash,
    () => "",
  );
}

export function useBrowserEvidence({
  sessionId,
  runId,
  artifactId,
  expanded,
}: BrowserEvidenceSelection & { sessionId: string; expanded: boolean }) {
  const [request, setRequest] = useState(0);
  const [result, setResult] = useState<BrowserEvidenceReceipt[] | "unavailable" | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(browserEvidencePath(sessionId, { runId, artifactId }), {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Evidence request failed.");
        const { browserEvidence } = exactBrowserEvidenceSchema.parse(await response.json());
        if (runId && browserEvidence.some((item) => item.runId !== runId)) {
          throw new Error("Evidence belongs to a different run.");
        }
        if (!controller.signal.aborted) setResult(browserEvidence);
      } catch {
        if (!controller.signal.aborted) setResult("unavailable");
      }
    })();
    return () => controller.abort();
  }, [artifactId, expanded, request, runId, sessionId]);

  return {
    result,
    reset: () => setResult(null),
    retry: () => {
      setResult(null);
      setRequest((value) => value + 1);
    },
  };
}
