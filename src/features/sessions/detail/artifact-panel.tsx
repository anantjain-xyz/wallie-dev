"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { Spinner } from "@/components/shared/spinner";
import { TimeDisplay } from "@/components/shared/time-display";
import { useOptionalToast } from "@/components/ui/toast";
import type {
  SessionArtifactBody,
  SessionArtifactMetadata,
  SessionArtifactSummary,
} from "@/features/sessions/types";
import { cn } from "@/lib/utils";

type ArtifactPanelProps = {
  emptyText: string;
  initialFormattedArtifact: ReactNode | null;
  initialFormattedArtifactKey: string | null;
  initialNow?: string;
  isDrafting: boolean;
  latestArtifact: SessionArtifactSummary | null;
  loadLatest: boolean;
  /**
   * When true, keep `artifactStage` in the URL even for the latest version so a
   * prior-stage selection survives refresh/share. Current-stage views omit it.
   */
  persistStageInUrl?: boolean;
  /**
   * Session-wide reject counter. Only pass for the session’s current stage —
   * prior-stage panels must omit it so a reject elsewhere cannot mark them.
   */
  rejectionCount?: number;
  /** Fires when the reviewer is (or is not) viewing a non-latest version. */
  onViewingHistoricalChange?: (viewingHistorical: boolean) => void;
  sessionId: string;
  stageSlug: string;
};

type ArtifactTab = "rendered" | "raw" | "versions";
type CachedArtifactBody = Omit<SessionArtifactBody, "sanitizedHtml"> & {
  sanitizedHtml?: string | null;
};

const ARTIFACT_TABS: ArtifactTab[] = ["rendered", "raw", "versions"];
export const ARTIFACT_VERSION_PARAM = "artifactVersion";
export const ARTIFACT_STAGE_PARAM = "artifactStage";

function stageCacheKey(sessionId: string, stageSlug: string) {
  return `${sessionId}:${stageSlug}`;
}

export function artifactBodyCacheKey(sessionId: string, stageSlug: string, version: number) {
  return `${stageCacheKey(sessionId, stageSlug)}:${version}`;
}

function asCachedBody(artifact: SessionArtifactSummary): CachedArtifactBody {
  return { ...artifact, sanitizedHtml: undefined };
}

function isArtifactBody(value: unknown): value is SessionArtifactBody {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<SessionArtifactBody>;
  return (
    typeof artifact.createdAt === "string" &&
    typeof artifact.stageSlug === "string" &&
    typeof artifact.version === "number" &&
    (typeof artifact.sanitizedHtml === "string" || artifact.sanitizedHtml === null) &&
    "payload" in artifact
  );
}

function isArtifactMetadataList(value: unknown): value is SessionArtifactMetadata[] {
  return (
    Array.isArray(value) &&
    value.every((artifact) => {
      if (!artifact || typeof artifact !== "object") return false;
      const row = artifact as Partial<SessionArtifactMetadata>;
      return (
        typeof row.createdAt === "string" &&
        typeof row.stageSlug === "string" &&
        typeof row.version === "number" &&
        typeof row.attempt === "number" &&
        typeof row.authorLabel === "string" &&
        typeof row.changesRequested === "boolean"
      );
    })
  );
}

function parseArtifactVersionParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Update view-only search params without an App Router navigation. `router.replace`
 * reloads the RSC payload and can overwrite newer Realtime session/artifact state
 * with a stale server snapshot (see session-detail-page-client initialData effect).
 */
function replaceClientSearchUrl(pathname: string, params: URLSearchParams) {
  const query = params.toString();
  const nextUrl = query ? `${pathname}?${query}` : pathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  if (nextUrl === currentUrl) return;
  window.history.replaceState(window.history.state, "", nextUrl);
}

function currentSearchParams() {
  // Prefer the live location so writes after replaceState stay consistent —
  // Next's useSearchParams does not update on history.replaceState.
  if (typeof window !== "undefined") {
    return new URLSearchParams(window.location.search);
  }
  return new URLSearchParams();
}

function applyPendingRejectionMarker(
  rows: SessionArtifactMetadata[],
  pendingRejectedVersion: number | null,
): SessionArtifactMetadata[] {
  if (pendingRejectedVersion === null) return rows;
  return rows.map((row) =>
    row.version === pendingRejectedVersion ? { ...row, changesRequested: true } : row,
  );
}

function setPendingAuthorRefreshState(
  pendingRef: { current: boolean },
  pendingByStage: Map<string, boolean>,
  stageKey: string,
  pending: boolean,
) {
  pendingRef.current = pending;
  if (pending) {
    pendingByStage.set(stageKey, true);
  } else {
    pendingByStage.delete(stageKey);
  }
}

function formatPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function ArtifactPanel(props: ArtifactPanelProps) {
  return <ArtifactPanelCache key={props.sessionId} {...props} />;
}

function ArtifactPanelCache({
  sessionId,
  stageSlug,
  persistStageInUrl = false,
  ...props
}: ArtifactPanelProps) {
  const pathname = usePathname();
  const [metadataCache] = useState(() => new Map<string, SessionArtifactMetadata[]>());
  const [bodyCache] = useState(() => new Map<string, CachedArtifactBody>());
  const [latestVersionCache] = useState(() => new Map<string, number>());
  /** Survives keyed stage remounts so rejection bumps while away are still detected. */
  const [seenRejectionCountByStage] = useState(() => new Map<string, number>());
  /** Survives keyed stage remounts so optimistic "Agent" author rows keep refreshing. */
  const [pendingAuthorRefreshByStage] = useState(() => new Map<string, boolean>());
  const [trackedStageSlug, setTrackedStageSlug] = useState(stageSlug);
  const stageJustChanged = trackedStageSlug !== stageSlug;
  const currentStageKey = stageCacheKey(sessionId, stageSlug);

  // Timeline stage changes: drop any historical version, and either pin the prior
  // stage in the URL (`artifactStage`) or clear stage params for the current stage.
  useEffect(() => {
    if (!stageJustChanged) return;
    queueMicrotask(() => setTrackedStageSlug(stageSlug));
    const params = currentSearchParams();
    params.delete(ARTIFACT_VERSION_PARAM);
    if (persistStageInUrl) {
      params.set(ARTIFACT_STAGE_PARAM, stageSlug);
    } else {
      params.delete(ARTIFACT_STAGE_PARAM);
    }
    replaceClientSearchUrl(pathname, params);
  }, [pathname, persistStageInUrl, stageJustChanged, stageSlug]);

  return (
    <ArtifactPanelStage
      key={currentStageKey}
      {...props}
      bodyCache={bodyCache}
      currentStageKey={currentStageKey}
      ignoreUrlVersion={stageJustChanged}
      latestVersionCache={latestVersionCache}
      metadataCache={metadataCache}
      pendingAuthorRefreshByStage={pendingAuthorRefreshByStage}
      persistStageInUrl={persistStageInUrl}
      seenRejectionCountByStage={seenRejectionCountByStage}
      sessionId={sessionId}
      stageSlug={stageSlug}
    />
  );
}

function ArtifactPanelStage({
  bodyCache,
  currentStageKey,
  emptyText,
  ignoreUrlVersion = false,
  initialFormattedArtifact,
  initialFormattedArtifactKey,
  initialNow = "1970-01-01T00:00:00.000Z",
  isDrafting,
  latestArtifact,
  loadLatest,
  latestVersionCache,
  metadataCache,
  onViewingHistoricalChange,
  pendingAuthorRefreshByStage,
  persistStageInUrl = false,
  rejectionCount,
  seenRejectionCountByStage,
  sessionId,
  stageSlug,
}: ArtifactPanelProps & {
  bodyCache: Map<string, CachedArtifactBody>;
  currentStageKey: string;
  ignoreUrlVersion?: boolean;
  latestVersionCache: Map<string, number>;
  metadataCache: Map<string, SessionArtifactMetadata[]>;
  pendingAuthorRefreshByStage: Map<string, boolean>;
  seenRejectionCountByStage: Map<string, number>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { pushToast } = useOptionalToast();

  const urlVersion = parseArtifactVersionParam(searchParams.get(ARTIFACT_VERSION_PARAM));
  const [activeTab, setActiveTab] = useState<ArtifactTab>("rendered");
  // URL is authoritative for shared links; local state updates immediately on
  // click. Client-side URL writes use history.replaceState (not router.replace)
  // so selecting a version does not trigger an RSC reload. When the stage just
  // changed, ignore a leftover stage-agnostic URL version.
  const [suppressUrlVersion, setSuppressUrlVersion] = useState(ignoreUrlVersion);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(() =>
    ignoreUrlVersion ? null : urlVersion,
  );
  const pendingAuthoritativeMetadata = useRef(
    pendingAuthorRefreshByStage.get(currentStageKey) === true,
  );
  const authorRefreshAttempts = useRef(0);
  const authorRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Version marked changes-requested while metadata was still null / in flight. */
  const pendingRejectedVersion = useRef<number | null>(null);
  // Prefer the parent-persisted baseline so remounting after a stage switch still
  // sees rejection bumps that landed while this stage panel was unmounted.
  const trackedRejectionCount = useRef(
    seenRejectionCountByStage.has(currentStageKey)
      ? seenRejectionCountByStage.get(currentStageKey)!
      : (rejectionCount ?? 0),
  );

  const [latestBody, setLatestBody] = useState<CachedArtifactBody | null>(() => {
    if (latestArtifact) return asCachedBody(latestArtifact);
    const cachedVersion = latestVersionCache.get(currentStageKey);
    return cachedVersion === undefined
      ? null
      : (bodyCache.get(artifactBodyCacheKey(sessionId, stageSlug, cachedVersion)) ?? null);
  });
  const [latestLoading, setLatestLoading] = useState(false);
  const [latestError, setLatestError] = useState<string | null>(null);
  const [latestRetry, setLatestRetry] = useState(0);
  // Drop optimistic "Agent" cache on remount when a refresh is still pending —
  // otherwise Versions would reuse the stale parent cache with a fresh false ref.
  const [metadata, setMetadata] = useState<SessionArtifactMetadata[] | null>(() => {
    if (pendingAuthorRefreshByStage.get(currentStageKey)) {
      metadataCache.delete(currentStageKey);
      return null;
    }
    return metadataCache.get(currentStageKey) ?? null;
  });
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadataRetry, setMetadataRetry] = useState(0);
  const [selectedBody, setSelectedBody] = useState<CachedArtifactBody | null>(null);
  const [selectedBodyLoading, setSelectedBodyLoading] = useState(false);
  const [selectedBodyError, setSelectedBodyError] = useState<string | null>(null);
  const [selectedBodyRetry, setSelectedBodyRetry] = useState(0);
  const metadataController = useRef<AbortController | null>(null);
  const latestBodyController = useRef<AbortController | null>(null);
  const selectedBodyController = useRef<AbortController | null>(null);
  const tabRefs = useRef(new Map<ArtifactTab, HTMLButtonElement>());
  const latestArtifactKey = latestArtifact
    ? artifactBodyCacheKey(sessionId, latestArtifact.stageSlug, latestArtifact.version)
    : null;
  const latestVersion =
    latestArtifact?.version ??
    latestBody?.version ??
    latestVersionCache.get(currentStageKey) ??
    null;
  const viewingVersion = selectedVersion ?? latestVersion;
  const viewingIsLatest =
    viewingVersion !== null && latestVersion !== null && viewingVersion === latestVersion;
  const viewingHistorical =
    selectedVersion !== null && latestVersion !== null && selectedVersion !== latestVersion;

  useEffect(() => {
    onViewingHistoricalChange?.(viewingHistorical);
    return () => onViewingHistoricalChange?.(false);
  }, [onViewingHistoricalChange, viewingHistorical]);

  // Seed the parent-persisted rejection baseline once per stage key so remounts
  // can detect bumps that landed while this panel was unmounted.
  useEffect(() => {
    if (rejectionCount === undefined) return;
    if (seenRejectionCountByStage.has(currentStageKey)) return;
    seenRejectionCountByStage.set(currentStageKey, trackedRejectionCount.current);
  }, [currentStageKey, rejectionCount, seenRejectionCountByStage]);

  function writeArtifactVersionToUrl(version: number | null) {
    const params = currentSearchParams();
    if (version === null || (latestVersion !== null && version === latestVersion)) {
      params.delete(ARTIFACT_VERSION_PARAM);
      // Prior-stage “Latest” still needs artifactStage so share/refresh stays on
      // that stage; the session’s current stage omits both params (default view).
      if (persistStageInUrl) {
        params.set(ARTIFACT_STAGE_PARAM, stageSlug);
      } else {
        params.delete(ARTIFACT_STAGE_PARAM);
      }
    } else {
      params.set(ARTIFACT_VERSION_PARAM, String(version));
      params.set(ARTIFACT_STAGE_PARAM, stageSlug);
    }
    replaceClientSearchUrl(pathname, params);
  }

  useEffect(() => {
    const previousLatestVersion = latestVersionCache.get(currentStageKey);

    if (latestArtifact) {
      if (previousLatestVersion !== undefined && latestArtifact.version < previousLatestVersion) {
        metadataCache.delete(currentStageKey);
        bodyCache.delete(artifactBodyCacheKey(sessionId, stageSlug, previousLatestVersion));
        queueMicrotask(() => setMetadata(null));
      }

      const bodyKey = artifactBodyCacheKey(
        sessionId,
        latestArtifact.stageSlug,
        latestArtifact.version,
      );
      const body = bodyCache.get(bodyKey) ?? asCachedBody(latestArtifact);
      bodyCache.set(bodyKey, body);
      latestVersionCache.set(currentStageKey, latestArtifact.version);

      const cachedMetadata = metadataCache.get(currentStageKey);
      if (cachedMetadata && !cachedMetadata.some((row) => row.version === latestArtifact.version)) {
        // Optimistic row for immediate UI. Delay the authoritative refetch until the
        // producing run is marked successful — the API only returns successful runs,
        // and markRunSuccess lands after phase_status flips to awaiting_review.
        const nextMetadata = applyPendingRejectionMarker(
          [
            {
              attempt: latestArtifact.version,
              authorLabel: "Agent",
              changesRequested: false,
              createdAt: latestArtifact.createdAt,
              stageSlug: latestArtifact.stageSlug,
              version: latestArtifact.version,
            },
            ...cachedMetadata,
          ].sort((left, right) => right.version - left.version),
          pendingRejectedVersion.current,
        );
        queueMicrotask(() => {
          setMetadata(nextMetadata);
          // Keep optimistic rows cached so Versions does not refetch mid-run.
          // Always flag pending refresh — even when !isDrafting, the success
          // run row may not exist yet (awaiting_review races markRunSuccess).
          metadataCache.set(currentStageKey, nextMetadata);
          setPendingAuthorRefreshState(
            pendingAuthoritativeMetadata,
            pendingAuthorRefreshByStage,
            currentStageKey,
            true,
          );
          if (!isDrafting) {
            authorRefreshAttempts.current = 0;
            metadataCache.delete(currentStageKey);
            setMetadataRetry((value) => value + 1);
          }
        });
      } else if (!cachedMetadata) {
        // Versions never opened. Flag author refresh when a new artifact arrives so
        // the first history fetch retries until markRunSuccess — but do not treat a
        // cold mount of an already-complete latest as "new" (that wastes fetches).
        const versionAdvanced =
          previousLatestVersion !== undefined && latestArtifact.version > previousLatestVersion;
        const firstArtifactDuringDraft = previousLatestVersion === undefined && isDrafting;
        if (versionAdvanced || firstArtifactDuringDraft) {
          setPendingAuthorRefreshState(
            pendingAuthoritativeMetadata,
            pendingAuthorRefreshByStage,
            currentStageKey,
            true,
          );
          if (!isDrafting && versionAdvanced) {
            authorRefreshAttempts.current = 0;
            queueMicrotask(() => setMetadataRetry((value) => value + 1));
          }
        }
      }
    } else if (previousLatestVersion !== undefined && !loadLatest) {
      queueMicrotask(() => {
        setLatestBody(null);
        setLatestLoading(false);
        setLatestError(null);
      });
      metadataCache.delete(currentStageKey);
      latestVersionCache.delete(currentStageKey);
      queueMicrotask(() => setMetadata(null));
    }
  }, [
    bodyCache,
    currentStageKey,
    isDrafting,
    latestArtifact,
    latestVersionCache,
    loadLatest,
    metadataCache,
    pendingAuthorRefreshByStage,
    sessionId,
    stageSlug,
  ]);

  // After drafting ends, refetch metadata so author labels come from successful
  // agent_runs. Keep pendingAuthoritativeMetadata until the response carries a
  // real author (or retries exhaust) — markRunSuccess lags awaiting_review.
  useEffect(() => {
    if (isDrafting || !pendingAuthoritativeMetadata.current) return;
    authorRefreshAttempts.current = 0;
    metadataCache.delete(currentStageKey);
    queueMicrotask(() => setMetadataRetry((value) => value + 1));
  }, [currentStageKey, isDrafting, metadataCache]);

  useEffect(() => {
    return () => {
      if (authorRefreshTimer.current !== null) {
        clearTimeout(authorRefreshTimer.current);
        authorRefreshTimer.current = null;
      }
    };
  }, []);

  // Reject does not create a new artifact version. Patch the marker locally and
  // write it into the cache — do not refetch yet. `rejection_count` can land
  // (optimistic UI or server CAS) before `session_artifact_feedback`, so an
  // immediate fetch can overwrite the marker with `changesRequested: false`.
  // Only the current-stage panel receives `rejectionCount`; prior stages omit it.
  useEffect(() => {
    if (rejectionCount === undefined) return;
    if (rejectionCount < trackedRejectionCount.current) {
      // Optimistic reject rolled back — drop the patched cache and refetch truth.
      trackedRejectionCount.current = rejectionCount;
      seenRejectionCountByStage.set(currentStageKey, rejectionCount);
      pendingRejectedVersion.current = null;
      metadataCache.delete(currentStageKey);
      queueMicrotask(() => {
        setMetadata(null);
        setMetadataRetry((value) => value + 1);
      });
      return;
    }
    if (rejectionCount === trackedRejectionCount.current) return;
    const previousCount = trackedRejectionCount.current;
    const delta = rejectionCount - previousCount;
    trackedRejectionCount.current = rejectionCount;
    seenRejectionCountByStage.set(currentStageKey, rejectionCount);
    const rejectedVersion =
      latestArtifact?.version ?? latestVersionCache.get(currentStageKey) ?? null;
    if (rejectedVersion !== null) {
      // Survive in-flight / null metadata so a later response cannot drop the marker.
      pendingRejectedVersion.current = rejectedVersion;
    }
    if (delta > 1) {
      // Multiple unseen rejections (e.g. while this stage panel was unmounted) —
      // a single local patch only covers the latest version. Invalidate and reload
      // so every newly rejected version gets its changes-requested marker.
      metadataCache.delete(currentStageKey);
      queueMicrotask(() => {
        setMetadata(null);
        setMetadataRetry((value) => value + 1);
      });
      return;
    }
    queueMicrotask(() => {
      setMetadata((rows) => {
        if (!rows || rejectedVersion === null) return rows;
        const next = applyPendingRejectionMarker(rows, rejectedVersion);
        metadataCache.set(currentStageKey, next);
        return next;
      });
    });
  }, [
    currentStageKey,
    latestArtifact,
    latestVersionCache,
    metadataCache,
    rejectionCount,
    seenRejectionCountByStage,
  ]);

  useEffect(() => {
    if (ignoreUrlVersion) {
      queueMicrotask(() => setSuppressUrlVersion(true));
    }
  }, [ignoreUrlVersion]);

  useEffect(() => {
    // After a stage switch we intentionally ignore a leftover URL version until the
    // router clears the param (or the user picks a version again).
    if (suppressUrlVersion) {
      if (urlVersion !== null) {
        queueMicrotask(() => setSelectedVersion(null));
        return;
      }
      queueMicrotask(() => setSuppressUrlVersion(false));
    }
    queueMicrotask(() => setSelectedVersion(urlVersion));
  }, [suppressUrlVersion, urlVersion]);

  // Load latest body for cache / default view.
  useEffect(() => {
    const cachedLatestVersion = latestArtifact?.version ?? latestVersionCache.get(currentStageKey);
    const cachedLatest =
      cachedLatestVersion === undefined
        ? null
        : bodyCache.get(artifactBodyCacheKey(sessionId, stageSlug, cachedLatestVersion));
    const body = cachedLatest ?? (latestArtifact ? asCachedBody(latestArtifact) : null);
    const bodyKey = body ? artifactBodyCacheKey(sessionId, body.stageSlug, body.version) : null;
    const hasFormattedBody =
      !body ||
      typeof body.payload !== "string" ||
      typeof body.sanitizedHtml === "string" ||
      bodyKey === initialFormattedArtifactKey;

    if (body && hasFormattedBody) {
      queueMicrotask(() => {
        setLatestBody((current) => {
          const currentKey = current
            ? artifactBodyCacheKey(sessionId, current.stageSlug, current.version)
            : null;
          return currentKey === bodyKey ? current : body;
        });
        setLatestLoading(false);
        setLatestError(null);
      });
      return;
    }
    if (!body && !loadLatest) {
      return;
    }

    const controller = new AbortController();
    latestBodyController.current?.abort();
    latestBodyController.current = controller;
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLatestBody(body);
      setLatestLoading(true);
      setLatestError(null);
    });
    const selector = body ? `version=${body.version}` : "latest=true";

    void fetch(
      `/api/sessions/${sessionId}/artifacts?stage=${encodeURIComponent(stageSlug)}&${selector}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          artifact?: unknown;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error ?? "Could not load the artifact.");
        if (!isArtifactBody(payload?.artifact)) throw new Error("Artifact response was invalid.");
        return payload.artifact;
      })
      .then((artifact) => {
        if (controller.signal.aborted) return;
        const key = artifactBodyCacheKey(sessionId, artifact.stageSlug, artifact.version);
        bodyCache.set(key, artifact);
        latestVersionCache.set(currentStageKey, artifact.version);
        setLatestBody(artifact);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLatestError(error instanceof Error ? error.message : "Could not load the artifact.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLatestLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [
    currentStageKey,
    initialFormattedArtifactKey,
    latestArtifact,
    latestArtifactKey,
    latestRetry,
    loadLatest,
    bodyCache,
    latestVersionCache,
    sessionId,
    stageSlug,
  ]);

  useEffect(() => {
    if (activeTab !== "versions") return;
    const cached = metadataCache.get(currentStageKey);
    // Pending author refresh must not trust an optimistic "Agent" cache left by a
    // prior mount — invalidate and refetch so retries survive stage switches.
    if (cached && pendingAuthoritativeMetadata.current) {
      metadataCache.delete(currentStageKey);
    } else if (cached) {
      const patched = applyPendingRejectionMarker(cached, pendingRejectedVersion.current);
      if (patched !== cached) {
        metadataCache.set(currentStageKey, patched);
        queueMicrotask(() => setMetadata(patched));
      }
      return;
    }

    const controller = new AbortController();
    metadataController.current?.abort();
    metadataController.current = controller;
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setMetadataLoading(true);
      setMetadataError(null);
    });

    void fetch(`/api/sessions/${sessionId}/artifacts?stage=${encodeURIComponent(stageSlug)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          artifacts?: unknown;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error ?? "Could not load version history.");
        if (!isArtifactMetadataList(payload?.artifacts)) {
          throw new Error("Version history response was invalid.");
        }
        return payload.artifacts;
      })
      .then((artifacts) => {
        if (controller.signal.aborted) return;
        const existing = metadataCache.get(currentStageKey);
        let result = artifacts;
        if (existing) {
          const apiVersions = new Set(artifacts.map((a) => a.version));
          const realtimeOnly = existing.filter((a) => !apiVersions.has(a.version));
          if (realtimeOnly.length > 0) {
            result = [...artifacts, ...realtimeOnly].sort((a, b) => b.version - a.version);
          }
        }
        result = applyPendingRejectionMarker(result, pendingRejectedVersion.current);
        metadataCache.set(currentStageKey, result);
        setMetadata(result);

        // Retry while the newest row is still the optimistic "Agent" label —
        // markRunSuccess can lag the awaiting_review session update.
        if (pendingAuthoritativeMetadata.current) {
          const maxVersion = Math.max(0, ...result.map((row) => row.version));
          const latestRow = result.find((row) => row.version === maxVersion);
          const stillOptimistic = latestRow?.authorLabel === "Agent";
          if (stillOptimistic && authorRefreshAttempts.current < 8) {
            authorRefreshAttempts.current += 1;
            if (authorRefreshTimer.current !== null) clearTimeout(authorRefreshTimer.current);
            authorRefreshTimer.current = setTimeout(() => {
              authorRefreshTimer.current = null;
              if (!pendingAuthoritativeMetadata.current) return;
              metadataCache.delete(currentStageKey);
              setMetadataRetry((value) => value + 1);
            }, 300);
          } else {
            setPendingAuthorRefreshState(
              pendingAuthoritativeMetadata,
              pendingAuthorRefreshByStage,
              currentStageKey,
              false,
            );
            authorRefreshAttempts.current = 0;
          }
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMetadataError(
          error instanceof Error ? error.message : "Could not load version history.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setMetadataLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [
    activeTab,
    currentStageKey,
    metadataCache,
    metadataRetry,
    pendingAuthorRefreshByStage,
    sessionId,
    stageSlug,
  ]);

  // Load non-latest selected version body when Rendered/Raw need it.
  useEffect(() => {
    if (activeTab === "versions" || viewingVersion === null || viewingIsLatest) {
      return;
    }
    const key = artifactBodyCacheKey(sessionId, stageSlug, viewingVersion);
    const cached = bodyCache.get(key);
    const canUseCached =
      cached &&
      (typeof cached.payload !== "string" ||
        typeof cached.sanitizedHtml === "string" ||
        key === initialFormattedArtifactKey);
    if (canUseCached) {
      queueMicrotask(() => {
        setSelectedBody(cached);
        setSelectedBodyLoading(false);
        setSelectedBodyError(null);
      });
      return;
    }

    const controller = new AbortController();
    selectedBodyController.current?.abort();
    selectedBodyController.current = controller;
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setSelectedBodyLoading(true);
      setSelectedBodyError(null);
    });

    void fetch(
      `/api/sessions/${sessionId}/artifacts?stage=${encodeURIComponent(stageSlug)}&version=${viewingVersion}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          artifact?: unknown;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error ?? "Could not load this version.");
        if (!isArtifactBody(payload?.artifact)) throw new Error("Artifact response was invalid.");
        return payload.artifact;
      })
      .then((artifact) => {
        if (controller.signal.aborted) return;
        bodyCache.set(key, artifact);
        setSelectedBody(artifact);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSelectedBodyError(
          error instanceof Error ? error.message : "Could not load this version.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setSelectedBodyLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [
    activeTab,
    bodyCache,
    initialFormattedArtifactKey,
    selectedBodyRetry,
    sessionId,
    stageSlug,
    viewingIsLatest,
    viewingVersion,
  ]);

  function selectTab(tab: ArtifactTab) {
    setActiveTab(tab);
  }

  function selectVersion(version: number) {
    setSuppressUrlVersion(false);
    setSelectedVersion(version === latestVersion ? null : version);
    setSelectedBody(null);
    setSelectedBodyError(null);
    setSelectedBodyLoading(false);
    writeArtifactVersionToUrl(version === latestVersion ? null : version);
    setActiveTab("rendered");
    // Versions buttons unmount with the tab; move focus into the reader so the
    // next Tab key continues through the artifact surface instead of document body.
    queueMicrotask(() => {
      tabRefs.current.get("rendered")?.focus();
    });
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = ARTIFACT_TABS.indexOf(activeTab);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight")
      nextIndex = Math.min(ARTIFACT_TABS.length - 1, currentIndex + 1);
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = ARTIFACT_TABS.length - 1;
    const nextTab = ARTIFACT_TABS[nextIndex] ?? "rendered";
    selectTab(nextTab);
    tabRefs.current.get(nextTab)?.focus();
  }

  const cachedSelectedBody =
    viewingVersion === null
      ? null
      : (bodyCache.get(artifactBodyCacheKey(sessionId, stageSlug, viewingVersion)) ?? null);
  const visibleBody = viewingIsLatest
    ? latestBody
    : selectedBody?.version === viewingVersion
      ? selectedBody
      : cachedSelectedBody;
  const bodyLoading = viewingIsLatest ? latestLoading : selectedBodyLoading;
  const bodyError = viewingIsLatest ? latestError : selectedBodyError;
  const retryBody = () => {
    if (viewingIsLatest) setLatestRetry((value) => value + 1);
    else setSelectedBodyRetry((value) => value + 1);
  };

  const tabLabels: Record<ArtifactTab, string> = {
    raw: "Raw",
    rendered: "Rendered",
    versions: "Versions",
  };

  const versionHeading =
    viewingVersion === null
      ? `${stageSlug} artifact`
      : `${stageSlug} artifact · version ${viewingVersion}${viewingIsLatest ? " (latest)" : ""}`;

  return (
    <div>
      <h3 className="sr-only" id="artifact-version-heading">
        {versionHeading}
      </h3>
      <div aria-label="Artifact views" className="mb-3 flex gap-1" role="tablist">
        {ARTIFACT_TABS.map((tab) => (
          <TabButton
            key={tab}
            active={activeTab === tab}
            controls={`artifact-${tab}-panel`}
            label={tabLabels[tab]}
            onClick={() => selectTab(tab)}
            onKeyDown={handleTabKeyDown}
            ref={(node) => {
              if (node) tabRefs.current.set(tab, node);
              else tabRefs.current.delete(tab);
            }}
            tabId={`artifact-${tab}-tab`}
          />
        ))}
      </div>

      {activeTab === "versions" ? (
        <div aria-labelledby="artifact-versions-tab" id="artifact-versions-panel" role="tabpanel">
          {metadataLoading ? <ProgressHint text="Loading version history." /> : null}
          {metadataError ? (
            <FailureHint
              message={metadataError}
              onRetry={() => setMetadataRetry((value) => value + 1)}
            />
          ) : null}
          {!metadataLoading && !metadataError && metadata?.length === 0 ? (
            <EmptyHint text="No artifact versions recorded for this stage." />
          ) : null}
          {metadata && metadata.length > 0 ? (
            <ul aria-labelledby="artifact-version-heading" className="space-y-2">
              {metadata.map((artifact) => {
                const isSelected = viewingVersion === artifact.version;
                const isLatest = artifact.version === latestVersion;
                return (
                  <li key={artifact.version}>
                    <button
                      type="button"
                      aria-current={isSelected ? "true" : undefined}
                      className={cn(
                        "w-full rounded-[6px] border px-3 py-2.5 text-left transition-colors",
                        isSelected
                          ? "border-accent/40 bg-accent-soft"
                          : "border-border hover:border-border-strong hover:bg-control-muted/40",
                      )}
                      onClick={() => selectVersion(artifact.version)}
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-xs font-semibold text-foreground">
                          Version {artifact.version}
                          {isLatest ? " · Latest" : ""}
                        </span>
                        {artifact.changesRequested ? (
                          <span className="rounded-[4px] bg-warning-soft px-1.5 py-0.5 type-annotation font-medium uppercase tracking-wide text-warning">
                            Changes requested
                          </span>
                        ) : null}
                      </div>
                      <dl className="mt-1.5 grid gap-1 type-annotation text-muted sm:grid-cols-2">
                        <div className="flex gap-1.5">
                          <dt className="after:content-[':']">Created</dt>
                          <dd>
                            <TimeDisplay initialNow={initialNow} value={artifact.createdAt} />
                          </dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt className="after:content-[':']">Stage</dt>
                          <dd className="font-mono tracking-normal">{artifact.stageSlug}</dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt className="after:content-[':']">Attempt</dt>
                          <dd>{artifact.attempt}</dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt className="after:content-[':']">Author</dt>
                          <dd>{artifact.authorLabel}</dd>
                        </div>
                      </dl>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : (
        <div
          aria-labelledby={`artifact-${activeTab}-tab`}
          id={`artifact-${activeTab}-panel`}
          role="tabpanel"
        >
          {isDrafting && visibleBody ? (
            <ProgressHint text="Wallie is drafting the next artifact version." />
          ) : null}
          {bodyError ? <FailureHint message={bodyError} onRetry={retryBody} /> : null}
          {bodyLoading && !visibleBody ? <ProgressHint text="Loading the artifact." /> : null}
          {visibleBody ? (
            <ArtifactBodyView
              artifact={visibleBody}
              displayMode={activeTab}
              initialFormattedArtifact={initialFormattedArtifact}
              initialFormattedArtifactKey={initialFormattedArtifactKey}
              initialNow={initialNow}
              onCopyResult={(result) => {
                if (result === "success") {
                  pushToast({
                    priority: "polite",
                    title: "Markdown copied.",
                    tone: "success",
                  });
                } else {
                  pushToast({
                    priority: "assertive",
                    title: "Could not copy Markdown.",
                    tone: "danger",
                  });
                }
              }}
              sessionId={sessionId}
              showLatestBadge={viewingIsLatest}
            />
          ) : bodyLoading ? null : isDrafting ? (
            <ProgressHint text="Wallie is drafting the artifact for this stage." />
          ) : !bodyError ? (
            <EmptyHint text={emptyText} />
          ) : null}
        </div>
      )}
    </div>
  );
}

type TabButtonProps = {
  active: boolean;
  controls: string;
  label: string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  ref: React.Ref<HTMLButtonElement>;
  tabId: string;
};

function TabButton({ active, controls, label, onClick, onKeyDown, ref, tabId }: TabButtonProps) {
  return (
    <button
      ref={ref}
      aria-controls={controls}
      aria-selected={active}
      className={cn(
        "rounded-[4px] px-2.5 py-1 text-xs font-medium",
        active ? "bg-control-muted text-foreground" : "text-muted hover:text-foreground",
      )}
      id={tabId}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      {label}
    </button>
  );
}

function ArtifactBodyView({
  artifact,
  displayMode,
  initialFormattedArtifact,
  initialFormattedArtifactKey,
  initialNow,
  onCopyResult,
  sessionId,
  showLatestBadge,
}: {
  artifact: CachedArtifactBody;
  displayMode: "rendered" | "raw";
  initialFormattedArtifact: ReactNode | null;
  initialFormattedArtifactKey: string | null;
  initialNow: string;
  onCopyResult: (result: "success" | "failure") => void;
  sessionId: string;
  showLatestBadge: boolean;
}) {
  const formatted = useMemo(() => formatPayload(artifact.payload), [artifact.payload]);
  const isMarkdown = typeof artifact.payload === "string";
  const key = artifactBodyCacheKey(sessionId, artifact.stageSlug, artifact.version);
  const serverTree = key === initialFormattedArtifactKey ? initialFormattedArtifact : null;
  const showRaw = !isMarkdown || displayMode === "raw";
  const [copyPending, setCopyPending] = useState(false);

  async function handleCopyMarkdown() {
    if (copyPending) return;
    setCopyPending(true);
    try {
      await navigator.clipboard.writeText(formatted);
      onCopyResult("success");
    } catch {
      onCopyResult("failure");
    } finally {
      setCopyPending(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="type-annotation uppercase tracking-wide text-muted">
          v{artifact.version}
          {showLatestBadge ? " · Latest" : ""} ·{" "}
          <TimeDisplay initialNow={initialNow} value={artifact.createdAt} />
        </p>
        {showRaw && isMarkdown ? (
          <button
            type="button"
            className="rounded-[4px] border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-control-muted"
            disabled={copyPending}
            onClick={() => {
              void handleCopyMarkdown();
            }}
          >
            {copyPending ? "Copying…" : "Copy Markdown"}
          </button>
        ) : null}
      </div>
      {isMarkdown && !showRaw ? (
        (serverTree ?? (
          <div
            // The API creates this markup with the same server-only Markdown renderer and
            // sanitization policy used for the initial server component tree.
            dangerouslySetInnerHTML={{ __html: artifact.sanitizedHtml ?? "" }}
          />
        ))
      ) : (
        <pre
          className={cn(
            "whitespace-pre-wrap break-words rounded-[4px] p-3 text-xs leading-5 text-foreground",
            !isMarkdown && "bg-canvas",
          )}
        >
          {formatted}
        </pre>
      )}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="rounded-[4px] border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
      {text}
    </p>
  );
}

function FailureHint({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      className="mb-3 flex items-center justify-between gap-3 rounded-[4px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
      role="alert"
    >
      <span>{message}</span>
      <button
        className="font-semibold underline underline-offset-2"
        onClick={onRetry}
        type="button"
      >
        Retry
      </button>
    </div>
  );
}

function ProgressHint({ text }: { text: string }) {
  return (
    <div
      className="mb-3 flex items-center justify-center gap-2 rounded-[4px] border border-accent/20 bg-accent-soft px-3 py-4 text-xs font-medium text-accent"
      role="status"
    >
      <Spinner />
      <span>{text}</span>
    </div>
  );
}
