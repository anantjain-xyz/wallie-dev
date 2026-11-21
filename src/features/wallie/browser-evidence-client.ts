"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import {
  browserEvidencePath,
  exactBrowserEvidenceSchema,
  type BrowserEvidenceScope,
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

export function useBrowserEvidence(scope: BrowserEvidenceScope, expanded: boolean) {
  const endpoint = scope.trial ? scope.trial.endpoint : browserEvidencePath(scope.sessionId, scope);
  const runId = scope.trial?.runId ?? scope.runId;
  const attemptCount = scope.trial?.attemptCount;
  const commitSha = scope.trial?.commitSha;
  const treeSha = scope.trial?.treeSha;
  const [request, setRequest] = useState(0);
  const [result, setResult] = useState<BrowserEvidenceReceipt[] | "unavailable" | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Evidence request failed.");
        const { browserEvidence } = exactBrowserEvidenceSchema.parse(await response.json());
        if (
          browserEvidence.some(
            (item) =>
              (runId !== undefined && item.runId !== runId) ||
              (attemptCount !== undefined && item.attemptCount !== attemptCount) ||
              (commitSha !== undefined && item.commitSha !== commitSha) ||
              (treeSha !== undefined && item.treeSha !== treeSha),
          )
        )
          throw new Error("Evidence belongs to a different revision.");
        if (!controller.signal.aborted) setResult(browserEvidence);
      } catch {
        if (!controller.signal.aborted) setResult("unavailable");
      }
    })();
    return () => controller.abort();
  }, [attemptCount, commitSha, endpoint, expanded, request, runId, treeSha]);

  return {
    result,
    reset: () => setResult(null),
    retry: () => {
      setResult(null);
      setRequest((value) => value + 1);
    },
  };
}

export async function fetchBrowserEvidenceAsset(
  path: string,
  signal: AbortSignal,
): Promise<Response | "expired" | "erased"> {
  const response = await fetch(path, { cache: "no-store", signal });
  if (response.status !== 410) return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (typeof body === "object" && body && "availability" in body) {
    if (body.availability === "expired" || body.availability === "erased") return body.availability;
  }
  return response;
}
