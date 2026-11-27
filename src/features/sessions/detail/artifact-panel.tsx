"use client";

import dynamic from "next/dynamic";

import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useSearchParams } from "next/navigation";

import { useChangeMotion } from "@/components/ui/use-change-motion";
import { CheckIcon } from "@/components/shared/icons/check-icon";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { Spinner } from "@/components/shared/spinner";
import { TimeDisplay } from "@/components/shared/time-display";
import { useOptionalToast } from "@/components/ui/toast";
import type {
  SessionArtifactBody,
  SessionArtifactMetadata,
  SessionArtifactSummary,
} from "@/features/sessions/types";
import { cn } from "@/lib/utils";
import { InlineArtifactReview } from "@/features/sessions/review/inline-artifact-review";
import type { ReviewSessionReadOnlyReason } from "@/features/sessions/review/comment-access";
import {
  isBrowserScreenshotHash,
  parseBrowserRecordingHash,
  SCREENSHOT_EVIDENCE_PARAM,
} from "@/features/wallie/browser-evidence-contracts";
import { useBrowserEvidenceHash } from "@/features/wallie/browser-evidence-client";
import { ArtifactEvidenceInspector } from "@/features/wallie/artifact-evidence-inspector";

export type DisplayedArtifactIdentity = Pick<
  SessionArtifactSummary,
  "id" | "stageSlug" | "version"
>;

type ArtifactPanelProps = {
  specification?: boolean;
  readOnlyReason?: ReviewSessionReadOnlyReason | null;
  /** Exact current-stage authority; null must not reuse a cached latest artifact. */
  currentArtifactId?: string | null;
  /**
   * The current stage is visible in awaiting_review. Its artifact can arrive just
   * before the successful agent_run row used for the Versions author label.
   */
  isAwaitingReview?: boolean;
  emptyText: string;
  exactArtifact?: { artifactId: string; artifactVersion: number } | null;
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
  retainBriefFor?: { artifactId: string; version: number };
  versionNamedAbove?: boolean;
  /** Fires when the reviewer is (or is not) viewing a non-latest version. */
  onViewingHistoricalChange?: (viewingHistorical: boolean) => void;
  /** Identity of the body actually presented, including cached or lazily loaded output. */
  onDisplayedArtifactChange?: (artifact: DisplayedArtifactIdentity | null) => void;
  sessionId: string;
  stageSlug: string;
};

const RevisionReviewPanel = dynamic(
  () =>
    import("@/features/sessions/review/revision-review-panel").then(
      (module) => module.RevisionReviewPanel,
    ),
  {
    loading: () => (
      <p role="status" className="text-xs text-muted">
        Loading revision review…
      </p>
    ),
  },
);

type ArtifactTab = "brief" | "rendered" | "raw" | "versions" | "compare";
type CachedArtifactBody = Omit<SessionArtifactBody, "sanitizedHtml"> & {
  sanitizedHtml?: string | null;
};

const VIEW_TABS = ["rendered", "raw"] as const;
const REVIEW_VIEW_TABS = ["brief", "rendered", "raw"] as const;
const HISTORY_TABS = ["versions", "compare"] as const;
export const ARTIFACT_ID_PARAM = "artifactId";
export const ARTIFACT_VERSION_PARAM = "artifactVersion";
export const ARTIFACT_STAGE_PARAM = "artifactStage";

function stageCacheKey(sessionId: string, stageSlug: string) {
  return `${sessionId}:${stageSlug}`;
}

export function artifactBodyCacheKey(
  sessionId: string,
  stageSlug: string,
  version: number,
  artifactId?: string,
) {
  return `${stageCacheKey(sessionId, stageSlug)}:${artifactId ? `id:${artifactId}` : version}`;
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
  pendingRejectedVersion: string | number | null,
): SessionArtifactMetadata[] {
  if (pendingRejectedVersion === null) return rows;
  return rows.map((row) =>
    (
      typeof pendingRejectedVersion === "string"
        ? row.id === pendingRejectedVersion
        : !row.id && row.version === pendingRejectedVersion
    )
      ? { ...row, changesRequested: true }
      : row,
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
  exactArtifact,
  sessionId,
  stageSlug,
  persistStageInUrl = false,
  ...props
}: ArtifactPanelProps) {
  const pathname = usePathname();
  const [metadataCache] = useState(() => new Map<string, SessionArtifactMetadata[]>());
  const [bodyCache] = useState(() => new Map<string, CachedArtifactBody>());
  const [latestArtifactIdCache] = useState(() => new Map<string, string>());
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
    if (!stageJustChanged || exactArtifact) return;
    queueMicrotask(() => setTrackedStageSlug(stageSlug));
    const params = currentSearchParams();
    params.delete(ARTIFACT_VERSION_PARAM);
    params.delete(ARTIFACT_ID_PARAM);
    if (persistStageInUrl) {
      params.set(ARTIFACT_STAGE_PARAM, stageSlug);
    } else {
      params.delete(ARTIFACT_STAGE_PARAM);
    }
    replaceClientSearchUrl(pathname, params);
  }, [exactArtifact, pathname, persistStageInUrl, stageJustChanged, stageSlug]);

  return (
    <ArtifactPanelStage
      key={`${currentStageKey}:${props.loadLatest ? "loaded" : "empty"}`}
      {...props}
      bodyCache={bodyCache}
      currentStageKey={currentStageKey}
      exactArtifact={exactArtifact}
      ignoreUrlVersion={stageJustChanged}
      latestArtifactIdCache={latestArtifactIdCache}
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
  currentArtifactId,
  currentStageKey,
  emptyText,
  exactArtifact,
  ignoreUrlVersion = false,
  initialFormattedArtifact,
  initialFormattedArtifactKey,
  initialNow = "1970-01-01T00:00:00.000Z",
  isAwaitingReview = false,
  isDrafting,
  latestArtifact,
  loadLatest,
  latestArtifactIdCache,
  latestVersionCache,
  metadataCache,
  onViewingHistoricalChange,
  onDisplayedArtifactChange,
  pendingAuthorRefreshByStage,
  persistStageInUrl = false,
  rejectionCount,
  readOnlyReason = null,
  retainBriefFor,
  seenRejectionCountByStage,
  sessionId,
  specification = false,
  stageSlug,
  versionNamedAbove = false,
}: ArtifactPanelProps & {
  bodyCache: Map<string, CachedArtifactBody>;
  currentStageKey: string;
  ignoreUrlVersion?: boolean;
  latestArtifactIdCache: Map<string, string>;
  latestVersionCache: Map<string, number>;
  metadataCache: Map<string, SessionArtifactMetadata[]>;
  pendingAuthorRefreshByStage: Map<string, boolean>;
  seenRejectionCountByStage: Map<string, number>;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { pushToast } = useOptionalToast();

  const urlArtifactId = searchParams.get(ARTIFACT_ID_PARAM);
  const [artifactIdSelection, setSelectedArtifactId] = useState<string | null>(() =>
    ignoreUrlVersion || !loadLatest ? null : urlArtifactId,
  );
  const urlVersion = parseArtifactVersionParam(searchParams.get(ARTIFACT_VERSION_PARAM));
  const [selectedTab, setSelectedTab] = useState<ArtifactTab | null>(null);
  const [openComments, setOpenComments] = useState(false);
  const showRawArtifact = useCallback(() => setSelectedTab("raw"), []);
  // URL is authoritative for shared links; local state updates immediately on
  // click. Client-side URL writes use history.replaceState (not router.replace)
  // so selecting a version does not trigger an RSC reload. When the stage just
  // changed, ignore a leftover stage-agnostic URL version.
  const [suppressUrlVersion, setSuppressUrlVersion] = useState(ignoreUrlVersion || !loadLatest);
  const [versionSelection, setSelectedVersion] = useState<number | null>(() =>
    ignoreUrlVersion || !loadLatest ? null : urlVersion,
  );
  const selectedArtifactId = exactArtifact?.artifactId ?? artifactIdSelection;
  const selectedVersion = exactArtifact?.artifactVersion ?? versionSelection;
  const pendingAuthoritativeMetadata = useRef(
    pendingAuthorRefreshByStage.get(currentStageKey) === true,
  );
  const authorRefreshAttempts = useRef(0);
  const authorRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Version marked changes-requested while metadata was still null / in flight. */
  const pendingRejectedVersion = useRef<string | number | null>(null);
  // Prefer the parent-persisted baseline so remounting after a stage switch still
  // sees rejection bumps that landed while this stage panel was unmounted.
  const trackedRejectionCount = useRef(
    seenRejectionCountByStage.has(currentStageKey)
      ? seenRejectionCountByStage.get(currentStageKey)!
      : (rejectionCount ?? 0),
  );

  const [latestBody, setLatestBody] = useState<CachedArtifactBody | null>(() => {
    if (!loadLatest || currentArtifactId === null) return null;
    if (
      latestArtifact &&
      (currentArtifactId === undefined || latestArtifact.id === currentArtifactId)
    )
      return asCachedBody(latestArtifact);
    const cachedVersion = latestVersionCache.get(currentStageKey);
    return cachedVersion === undefined
      ? null
      : (bodyCache.get(
          artifactBodyCacheKey(
            sessionId,
            stageSlug,
            cachedVersion,
            currentArtifactId ?? latestArtifactIdCache.get(currentStageKey),
          ),
        ) ?? null);
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
    ? artifactBodyCacheKey(
        sessionId,
        latestArtifact.stageSlug,
        latestArtifact.version,
        latestArtifact.id,
      )
    : null;
  const latestVersion = loadLatest
    ? (latestArtifact?.version ??
      latestBody?.version ??
      latestVersionCache.get(currentStageKey) ??
      null)
    : null;
  const latestArtifactId =
    currentArtifactId !== undefined
      ? currentArtifactId
      : (latestArtifact?.id ??
        latestBody?.id ??
        latestArtifactIdCache.get(currentStageKey) ??
        null);
  const viewingVersion =
    selectedVersion ??
    (selectedArtifactId && selectedBody?.id === selectedArtifactId ? selectedBody.version : null) ??
    metadata?.find((row) => row.id === selectedArtifactId)?.version ??
    latestVersion;
  const viewingIsLatest = selectedArtifactId
    ? selectedArtifactId === latestArtifactId
    : selectedVersion === null ||
      (!latestArtifactId && viewingVersion !== null && viewingVersion === latestVersion);
  const viewingHistorical = selectedArtifactId
    ? selectedArtifactId !== latestArtifactId
    : selectedVersion !== null && (latestArtifactId !== null || selectedVersion !== latestVersion);
  const cachedSelectedBody =
    viewingVersion === null && !selectedArtifactId
      ? null
      : (bodyCache.get(
          artifactBodyCacheKey(
            sessionId,
            stageSlug,
            viewingVersion ?? 0,
            selectedArtifactId ?? undefined,
          ),
        ) ?? null);
  const useLatestBody = viewingIsLatest && !exactArtifact;
  const selectedVersionBody = (
    selectedArtifactId
      ? selectedBody?.id === selectedArtifactId
      : selectedBody?.version === viewingVersion
  )
    ? selectedBody
    : cachedSelectedBody;
  const displayedBody = useLatestBody
    ? currentArtifactId !== undefined && latestBody?.id !== currentArtifactId
      ? null
      : latestBody
    : (selectedVersionBody ?? (exactArtifact && viewingIsLatest ? latestBody : null));
  const visibleBody =
    !exactArtifact ||
    (displayedBody?.id === exactArtifact.artifactId &&
      displayedBody.version === exactArtifact.artifactVersion &&
      displayedBody.stageSlug === stageSlug)
      ? displayedBody
      : null;
  const hasReviewBrief =
    viewingIsLatest &&
    !viewingHistorical &&
    visibleBody?.id &&
    visibleBody.version > 1 &&
    typeof visibleBody.payload === "string" &&
    ((isAwaitingReview && !readOnlyReason) ||
      (retainBriefFor?.artifactId === visibleBody.id &&
        retainBriefFor.version === visibleBody.version));
  const viewTabs = hasReviewBrief ? REVIEW_VIEW_TABS : VIEW_TABS;
  const tabs: ArtifactTab[] = [...viewTabs, ...HISTORY_TABS];
  const defaultTab = hasReviewBrief && !searchParams.has("reviewThread") ? "brief" : "rendered";
  const activeTab = selectedTab && tabs.includes(selectedTab) ? selectedTab : defaultTab;

  useLayoutEffect(() => {
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

  function writeArtifactVersionToUrl(version: number | null, artifactId: string | null) {
    const params = currentSearchParams();
    if (artifactId ? artifactId === latestArtifactId : version === null) {
      params.delete(ARTIFACT_VERSION_PARAM);
      params.delete(ARTIFACT_ID_PARAM);
      // Prior-stage “Latest” still needs artifactStage so share/refresh stays on
      // that stage; the session’s current stage omits both params (default view).
      if (persistStageInUrl) {
        params.set(ARTIFACT_STAGE_PARAM, stageSlug);
      } else {
        params.delete(ARTIFACT_STAGE_PARAM);
      }
    } else {
      if (artifactId) params.set(ARTIFACT_ID_PARAM, artifactId);
      else params.delete(ARTIFACT_ID_PARAM);
      params.set(ARTIFACT_VERSION_PARAM, String(version));
      params.set(ARTIFACT_STAGE_PARAM, stageSlug);
    }
    replaceClientSearchUrl(pathname, params);
  }

  useEffect(() => {
    const previousLatestVersion = latestVersionCache.get(currentStageKey);

    if (latestArtifact && loadLatest) {
      if (previousLatestVersion !== undefined && latestArtifact.version < previousLatestVersion) {
        metadataCache.delete(currentStageKey);
        bodyCache.delete(
          artifactBodyCacheKey(
            sessionId,
            stageSlug,
            previousLatestVersion,
            latestArtifactIdCache.get(currentStageKey),
          ),
        );
        queueMicrotask(() => setMetadata(null));
      }

      const bodyKey = artifactBodyCacheKey(
        sessionId,
        latestArtifact.stageSlug,
        latestArtifact.version,
        latestArtifact.id,
      );
      const body = bodyCache.get(bodyKey) ?? asCachedBody(latestArtifact);
      bodyCache.set(bodyKey, body);
      latestVersionCache.set(currentStageKey, latestArtifact.version);
      if (latestArtifact.id) latestArtifactIdCache.set(currentStageKey, latestArtifact.id);

      const cachedMetadata = metadataCache.get(currentStageKey);
      if (
        cachedMetadata &&
        !cachedMetadata.some((row) =>
          latestArtifact.id ? row.id === latestArtifact.id : row.version === latestArtifact.version,
        )
      ) {
        // Optimistic row for immediate UI. Delay the authoritative refetch until the
        // producing run is marked successful — the API only returns successful runs,
        // and markRunSuccess lands after phase_status flips to awaiting_review.
        const nextMetadata = applyPendingRejectionMarker(
          [
            {
              id: latestArtifact.id,
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
        // the first history fetch retries until markRunSuccess. Awaiting-review is
        // included because the session update precedes markRunSuccess; completed
        // prior-stage cold mounts do not opt into the retry path.
        const versionAdvanced =
          previousLatestVersion !== undefined && latestArtifact.version > previousLatestVersion;
        const firstArtifactMayHavePendingAuthor =
          previousLatestVersion === undefined && (isDrafting || isAwaitingReview);
        if (versionAdvanced || firstArtifactMayHavePendingAuthor) {
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
    } else if (!loadLatest) {
      latestBodyController.current?.abort();
      selectedBodyController.current?.abort();
      metadataController.current?.abort();
      if (authorRefreshTimer.current !== null) {
        clearTimeout(authorRefreshTimer.current);
        authorRefreshTimer.current = null;
      }
      authorRefreshAttempts.current = 0;
      pendingRejectedVersion.current = null;
      setPendingAuthorRefreshState(
        pendingAuthoritativeMetadata,
        pendingAuthorRefreshByStage,
        currentStageKey,
        false,
      );

      const bodyKeyPrefix = `${currentStageKey}:`;
      for (const key of bodyCache.keys()) {
        if (key.startsWith(bodyKeyPrefix)) bodyCache.delete(key);
      }
      metadataCache.delete(currentStageKey);
      latestVersionCache.delete(currentStageKey);
      latestArtifactIdCache.delete(currentStageKey);
      seenRejectionCountByStage.delete(currentStageKey);

      const params = currentSearchParams();
      params.delete(ARTIFACT_VERSION_PARAM);
      params.delete(ARTIFACT_ID_PARAM);
      if (persistStageInUrl) {
        params.set(ARTIFACT_STAGE_PARAM, stageSlug);
      } else {
        params.delete(ARTIFACT_STAGE_PARAM);
      }
      replaceClientSearchUrl(pathname, params);

      queueMicrotask(() => {
        setLatestBody(null);
        setLatestLoading(false);
        setLatestError(null);
        setMetadata(null);
        setMetadataLoading(false);
        setMetadataError(null);
        setSelectedVersion(null);
        setSelectedArtifactId(null);
        setSelectedBody(null);
        setSelectedBodyLoading(false);
        setSelectedBodyError(null);
        setSuppressUrlVersion(true);
      });
    }
  }, [
    bodyCache,
    currentStageKey,
    isAwaitingReview,
    isDrafting,
    latestArtifact,
    latestArtifactIdCache,
    latestVersionCache,
    loadLatest,
    metadataCache,
    pathname,
    pendingAuthorRefreshByStage,
    persistStageInUrl,
    seenRejectionCountByStage,
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
      latestArtifactId ??
      latestArtifact?.version ??
      latestVersionCache.get(currentStageKey) ??
      null;
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
    latestArtifactId,
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
    if (exactArtifact) return;
    if (suppressUrlVersion) {
      if (urlVersion !== null || urlArtifactId !== null) {
        queueMicrotask(() => {
          setSelectedVersion(null);
          setSelectedArtifactId(null);
        });
        return;
      }
      queueMicrotask(() => setSuppressUrlVersion(false));
    }
    queueMicrotask(() => {
      setSelectedVersion(urlVersion);
      setSelectedArtifactId(urlArtifactId);
    });
  }, [exactArtifact, suppressUrlVersion, urlVersion, urlArtifactId]);

  // Load latest body for cache / default view.
  useEffect(() => {
    if (!loadLatest || exactArtifact) return;
    if (currentArtifactId === null) {
      latestBodyController.current?.abort();
      queueMicrotask(() => {
        setLatestBody(null);
        setLatestLoading(false);
        setLatestError(
          "The current artifact is unavailable. Use Retry Run to generate a new reviewable artifact.",
        );
      });
      return;
    }
    const cachedLatestVersion = latestArtifact?.version ?? latestVersionCache.get(currentStageKey);
    const cachedLatest =
      cachedLatestVersion === undefined
        ? null
        : bodyCache.get(
            artifactBodyCacheKey(
              sessionId,
              stageSlug,
              cachedLatestVersion,
              currentArtifactId ?? latestArtifact?.id ?? latestArtifactIdCache.get(currentStageKey),
            ),
          );
    const body =
      cachedLatest ??
      (latestArtifact &&
      (currentArtifactId === undefined || latestArtifact.id === currentArtifactId)
        ? asCachedBody(latestArtifact)
        : null);
    const bodyKey = body
      ? artifactBodyCacheKey(sessionId, body.stageSlug, body.version, body.id)
      : null;
    const hasFormattedBody =
      !body ||
      typeof body.payload !== "string" ||
      typeof body.sanitizedHtml === "string" ||
      bodyKey === initialFormattedArtifactKey;

    if (body && hasFormattedBody) {
      queueMicrotask(() => {
        setLatestBody((current) => {
          const currentKey = current
            ? artifactBodyCacheKey(sessionId, current.stageSlug, current.version, current.id)
            : null;
          return currentKey === bodyKey ? current : body;
        });
        setLatestLoading(false);
        setLatestError(null);
      });
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
    const requestedArtifactId = currentArtifactId ?? body?.id;
    const selector = requestedArtifactId
      ? `artifactId=${encodeURIComponent(requestedArtifactId)}`
      : body
        ? `version=${body.version}`
        : "latest=true";

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
        if (requestedArtifactId && payload.artifact.id !== requestedArtifactId)
          throw new Error("Artifact response did not match the requested artifact.");
        return payload.artifact;
      })
      .then((artifact) => {
        if (controller.signal.aborted) return;
        const key = artifactBodyCacheKey(
          sessionId,
          artifact.stageSlug,
          artifact.version,
          artifact.id,
        );
        bodyCache.set(key, artifact);
        latestVersionCache.set(currentStageKey, artifact.version);
        if (artifact.id) latestArtifactIdCache.set(currentStageKey, artifact.id);
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
    currentArtifactId,
    currentStageKey,
    exactArtifact,
    initialFormattedArtifactKey,
    latestArtifact,
    latestArtifactKey,
    latestRetry,
    loadLatest,
    bodyCache,
    latestArtifactIdCache,
    latestVersionCache,
    sessionId,
    stageSlug,
  ]);

  useEffect(() => {
    if (activeTab !== "versions" || !loadLatest) return;
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
          const apiIdentities = new Set(artifacts.map((a) => a.id ?? `version:${a.version}`));
          const realtimeOnly = existing.filter(
            (a) => !apiIdentities.has(a.id ?? `version:${a.version}`),
          );
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
          const latestRow = latestArtifactId
            ? result.find((row) => row.id === latestArtifactId)
            : result.find((row) => row.version === maxVersion);
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
    latestArtifactId,
    loadLatest,
    metadataCache,
    metadataRetry,
    pendingAuthorRefreshByStage,
    sessionId,
    stageSlug,
  ]);

  // Load a pinned artifact or a historical selection by its exact selector.
  useEffect(() => {
    if (
      activeTab === "versions" ||
      (viewingVersion === null && !selectedArtifactId) ||
      useLatestBody
    ) {
      return;
    }
    const key = artifactBodyCacheKey(
      sessionId,
      stageSlug,
      viewingVersion ?? 0,
      selectedArtifactId ?? undefined,
    );
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
      `/api/sessions/${sessionId}/artifacts?stage=${encodeURIComponent(stageSlug)}&${selectedArtifactId ? `artifactId=${encodeURIComponent(selectedArtifactId)}` : `version=${viewingVersion}`}`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          artifact?: unknown;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error ?? "Could not load this version.");
        if (!isArtifactBody(payload?.artifact)) throw new Error("Artifact response was invalid.");
        if (
          (selectedArtifactId && payload.artifact.id !== selectedArtifactId) ||
          (exactArtifact &&
            (payload.artifact.version !== exactArtifact.artifactVersion ||
              payload.artifact.stageSlug !== stageSlug))
        )
          throw new Error("Artifact response did not match the requested artifact.");
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
    exactArtifact,
    initialFormattedArtifactKey,
    selectedBodyRetry,
    sessionId,
    stageSlug,
    useLatestBody,
    viewingVersion,
    selectedArtifactId,
  ]);

  function selectTab(tab: ArtifactTab) {
    setSelectedTab(tab);
    setOpenComments(false);
  }

  function selectVersion(artifact: SessionArtifactMetadata) {
    if (exactArtifact) return;
    const { version, id } = artifact;
    const isLatest = id ? id === latestArtifactId : version === latestVersion;
    setSuppressUrlVersion(false);
    setSelectedVersion(isLatest ? null : version);
    setSelectedArtifactId(isLatest ? null : (id ?? null));
    setSelectedBody(null);
    setSelectedBodyError(null);
    setSelectedBodyLoading(false);
    writeArtifactVersionToUrl(isLatest ? null : version, id ?? null);
    selectTab("rendered");
    // Versions buttons unmount with the tab; move focus into the reader so the
    // next Tab key continues through the artifact surface instead of document body.
    queueMicrotask(() => {
      tabRefs.current.get("rendered")?.focus();
    });
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.indexOf(activeTab);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = Math.min(tabs.length - 1, currentIndex + 1);
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    const nextTab = tabs[nextIndex] ?? "rendered";
    selectTab(nextTab);
    tabRefs.current.get(nextTab)?.focus();
  }

  const bodyHasContent =
    visibleBody &&
    (activeTab === "raw" ||
      typeof visibleBody.payload !== "string" ||
      typeof visibleBody.sanitizedHtml === "string" ||
      (artifactBodyCacheKey(
        sessionId,
        visibleBody.stageSlug,
        visibleBody.version,
        visibleBody.id,
      ) === initialFormattedArtifactKey &&
        initialFormattedArtifact !== null));
  const displayedArtifactId = bodyHasContent ? visibleBody.id : undefined;
  const displayedArtifactStage = bodyHasContent ? visibleBody.stageSlug : undefined;
  const displayedArtifactVersion = bodyHasContent ? visibleBody.version : undefined;
  useLayoutEffect(() => {
    onDisplayedArtifactChange?.(
      displayedArtifactStage && displayedArtifactVersion !== undefined
        ? {
            id: displayedArtifactId,
            stageSlug: displayedArtifactStage,
            version: displayedArtifactVersion,
          }
        : null,
    );
    return () => onDisplayedArtifactChange?.(null);
  }, [
    onDisplayedArtifactChange,
    displayedArtifactId,
    displayedArtifactStage,
    displayedArtifactVersion,
  ]);

  const bodyMotionRef = useChangeMotion<HTMLDivElement>(
    `${sessionId}:${visibleBody?.stageSlug ?? stageSlug}:${activeTab}:${bodyHasContent ? visibleBody.version : "loading"}`,
  );
  const bodyLoading = useLatestBody ? latestLoading : selectedBodyLoading;
  const bodyError = useLatestBody ? latestError : selectedBodyError;
  const retryBody = () => {
    if (useLatestBody) setLatestRetry((value) => value + 1);
    else setSelectedBodyRetry((value) => value + 1);
  };

  const tabLabels: Record<ArtifactTab, string> = {
    brief: "Review brief",
    raw: "Raw",
    rendered: hasReviewBrief ? "Full artifact" : "Rendered",
    versions: "Versions",
    compare: hasReviewBrief ? "Compare versions" : "Compare",
  };

  return (
    <div>
      {!versionNamedAbove && activeTab !== "versions" && viewingVersion !== null ? (
        <p className="mb-2 text-xs font-medium text-muted">
          v{viewingVersion}
          {viewingIsLatest ? " · Latest" : " · Historical"}
        </p>
      ) : null}
      <div className="mb-3 flex flex-wrap items-end gap-x-2 gap-y-1 sm:gap-x-4">
        <div
          aria-label={specification ? "Specification views" : "Artifact views"}
          className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1 sm:gap-x-4"
          role="tablist"
        >
          {(
            [
              { label: "View", tabs: viewTabs },
              { label: "History", tabs: HISTORY_TABS },
            ] as const
          ).map((group) => (
            <div aria-label={group.label} key={group.label} role="group">
              <span aria-hidden="true" className="type-annotation block text-muted">
                {group.label}
              </span>
              <div className="flex flex-wrap gap-1">
                {group.tabs.map((tab) => (
                  <TabButton
                    key={tab}
                    active={activeTab === tab}
                    controls={`artifact-${tab}-panel`}
                    label={tabLabels[tab]}
                    shortLabel={
                      tab === "brief"
                        ? "Brief"
                        : tab === "rendered" && hasReviewBrief
                          ? "Full"
                          : tab === "compare"
                            ? "Compare"
                            : undefined
                    }
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
            </div>
          ))}
        </div>
        {activeTab === "brief" ? (
          <button
            className="min-h-11 rounded-[4px] px-2 text-xs text-muted hover:text-foreground hover:underline focus-visible:outline-accent sm:min-h-8"
            onClick={() => {
              setSelectedTab("rendered");
              setOpenComments(true);
              tabRefs.current.get("rendered")?.focus();
            }}
            type="button"
          >
            Comments
          </button>
        ) : null}
        {activeTab !== "versions" && visibleBody?.id ? (
          <ArtifactEvidenceTools
            artifactId={visibleBody.id}
            sessionId={sessionId}
            stageSlug={stageSlug}
            version={visibleBody.version}
          />
        ) : null}
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
            <ul aria-label="Artifact versions" className="space-y-2">
              {metadata.map((artifact) => {
                const isLatest = artifact.id
                  ? artifact.id === latestArtifactId
                  : artifact.version === latestVersion;
                const isSelected = selectedArtifactId
                  ? artifact.id === selectedArtifactId
                  : viewingIsLatest
                    ? isLatest
                    : viewingVersion === artifact.version;
                return (
                  <li key={artifact.id ?? artifact.version}>
                    <button
                      type="button"
                      disabled={Boolean(exactArtifact)}
                      aria-current={isSelected ? "true" : undefined}
                      className={cn(
                        "w-full rounded-[6px] border px-3 py-2.5 text-left transition-colors",
                        isSelected
                          ? "border-accent/40 bg-accent-soft"
                          : "border-border hover:border-border-strong hover:bg-control-muted/40",
                      )}
                      onClick={() => selectVersion(artifact)}
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
      ) : activeTab === "brief" || activeTab === "compare" ? (
        <div
          aria-labelledby={`artifact-${activeTab}-tab`}
          id={`artifact-${activeTab}-panel`}
          role="tabpanel"
        >
          {visibleBody?.id ? (
            <RevisionReviewPanel
              key={visibleBody.id}
              sessionId={sessionId}
              artifactId={visibleBody.id}
              version={visibleBody.version}
              stageSlug={stageSlug}
              source={visibleBody.payload}
              view={activeTab}
            />
          ) : bodyError ? (
            <FailureHint message={bodyError} onRetry={retryBody} />
          ) : (
            <ProgressHint text="Loading artifact identity for comparison." />
          )}
        </div>
      ) : (
        <div
          aria-labelledby={`artifact-${activeTab}-tab`}
          id={`artifact-${activeTab}-panel`}
          role="tabpanel"
        >
          {isDrafting && visibleBody ? (
            <ProgressHint text="Waiting for the next artifact version. Follow progress in Runs below." />
          ) : null}
          {bodyError ? <FailureHint message={bodyError} onRetry={retryBody} /> : null}
          {bodyLoading && !visibleBody ? <ProgressHint text="Loading the artifact." /> : null}
          {visibleBody ? (
            <ArtifactBodyView
              motionRef={bodyHasContent ? bodyMotionRef : undefined}
              artifact={visibleBody}
              displayMode={activeTab}
              initialFormattedArtifact={initialFormattedArtifact}
              initialFormattedArtifactKey={initialFormattedArtifactKey}
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
              historical={persistStageInUrl || !viewingIsLatest}
              openComments={openComments}
              onShowRaw={showRawArtifact}
              readOnlyReason={readOnlyReason}
            />
          ) : bodyLoading ? null : isDrafting ? (
            <ProgressHint text="Waiting for this stage’s artifact. Follow progress in Runs below." />
          ) : !bodyError ? (
            <EmptyHint text={emptyText} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ArtifactEvidenceTools({
  artifactId,
  sessionId,
  stageSlug,
  version,
}: {
  artifactId: string;
  sessionId: string;
  stageSlug: string;
  version: number;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const hash = useBrowserEvidenceHash();
  useLayoutEffect(() => {
    if (ref.current && (isBrowserScreenshotHash(hash) || parseBrowserRecordingHash(hash))) {
      ref.current.open = true;
    }
  }, [hash, artifactId]);

  return (
    <details className="group/evidence min-w-0 open:w-full" ref={ref}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-[4px] px-2 text-xs text-muted hover:text-foreground focus-visible:outline-accent sm:min-h-8 [&::-webkit-details-marker]:hidden">
        Evidence
        <ChevronDownIcon aria-hidden="true" className="size-3.5 group-open/evidence:rotate-180" />
      </summary>
      <div className="hidden min-w-0 border-t border-border py-3 group-open/evidence:block">
        <ArtifactEvidenceInspector
          source={{
            kind: "review",
            sessionId,
            artifactId,
            artifactLinkQuery: new URLSearchParams({
              [ARTIFACT_STAGE_PARAM]: stageSlug,
              [ARTIFACT_ID_PARAM]: artifactId,
              [ARTIFACT_VERSION_PARAM]: String(version),
              [SCREENSHOT_EVIDENCE_PARAM]: "1",
            }).toString(),
          }}
        />
      </div>
    </details>
  );
}

type TabButtonProps = {
  active: boolean;
  controls: string;
  label: string;
  shortLabel?: string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  ref: React.Ref<HTMLButtonElement>;
  tabId: string;
};

function TabButton({
  active,
  controls,
  label,
  shortLabel,
  onClick,
  onKeyDown,
  ref,
  tabId,
}: TabButtonProps) {
  return (
    <button
      ref={ref}
      aria-controls={controls}
      aria-label={shortLabel ? label : undefined}
      aria-selected={active}
      className={cn(
        "min-h-11 rounded-[4px] px-2 py-1 text-xs font-medium focus-visible:outline-accent sm:min-h-8 sm:px-2.5",
        active ? "bg-control-muted text-foreground" : "text-muted hover:text-foreground",
      )}
      id={tabId}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      {shortLabel ?? label}
    </button>
  );
}

function ArtifactBodyView({
  motionRef,
  artifact,
  displayMode,
  initialFormattedArtifact,
  initialFormattedArtifactKey,
  onCopyResult,
  sessionId,
  historical,
  openComments,
  onShowRaw,
  readOnlyReason,
}: {
  motionRef?: RefObject<HTMLDivElement | null>;
  artifact: CachedArtifactBody;
  displayMode: "rendered" | "raw";
  initialFormattedArtifact: ReactNode | null;
  initialFormattedArtifactKey: string | null;
  onCopyResult: (result: "success" | "failure") => void;
  sessionId: string;
  historical: boolean;
  openComments: boolean;
  onShowRaw: () => void;
  readOnlyReason: ReviewSessionReadOnlyReason | null;
}) {
  const formatted = useMemo(() => formatPayload(artifact.payload), [artifact.payload]);
  const isMarkdown = typeof artifact.payload === "string";
  const key = artifactBodyCacheKey(sessionId, artifact.stageSlug, artifact.version, artifact.id);
  const serverTree = key === initialFormattedArtifactKey ? initialFormattedArtifact : null;
  const showRaw = !isMarkdown || displayMode === "raw";
  const [copyPending, setCopyPending] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  async function handleCopyMarkdown() {
    if (copyPending) return;
    setCopyPending(true);
    try {
      await navigator.clipboard.writeText(formatted);
      if (mounted.current) {
        setCopiedKey(key);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopiedKey(null), 1800);
      }
      onCopyResult("success");
    } catch {
      if (mounted.current) setCopiedKey(null);
      onCopyResult("failure");
    } finally {
      if (mounted.current) setCopyPending(false);
    }
  }

  const content =
    isMarkdown && !showRaw ? (
      (serverTree ?? <div dangerouslySetInnerHTML={{ __html: artifact.sanitizedHtml ?? "" }} />)
    ) : (
      <pre
        data-review-text-start={isMarkdown ? 0 : undefined}
        data-review-text-end={isMarkdown ? Array.from(formatted).length : undefined}
        className={cn(
          "whitespace-pre-wrap break-words rounded-[4px] p-3 text-xs leading-5 text-foreground",
          !isMarkdown && "bg-canvas",
        )}
      >
        {formatted}
      </pre>
    );

  return (
    <div>
      {showRaw && isMarkdown ? (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            className="inline-grid min-h-11 items-center justify-center rounded-[4px] border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-control-muted focus-visible:outline-accent sm:min-h-8"
            aria-disabled={copyPending}
            aria-busy={copyPending}
            onClick={() => {
              void handleCopyMarkdown();
            }}
          >
            <span aria-hidden="true" className="invisible col-start-1 row-start-1">
              Copy Markdown
            </span>
            <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5">
              {copiedKey === key && !copyPending ? <CheckIcon className="h-3.5 w-3.5" /> : null}
              <span aria-live="polite">
                {copyPending ? "Copying…" : copiedKey === key ? "Copied" : "Copy Markdown"}
              </span>
            </span>
          </button>
        </div>
      ) : null}
      {isMarkdown && artifact.id ? (
        <InlineArtifactReview
          key={artifact.id}
          sessionId={sessionId}
          artifactId={artifact.id}
          artifactVersion={artifact.version}
          source={formatted}
          historical={historical}
          initiallyOpen={openComments}
          displayMode={displayMode}
          onShowRaw={onShowRaw}
          motionRef={motionRef}
          readOnlyReason={readOnlyReason}
        >
          {content}
        </InlineArtifactReview>
      ) : (
        <div ref={motionRef}>{content}</div>
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
