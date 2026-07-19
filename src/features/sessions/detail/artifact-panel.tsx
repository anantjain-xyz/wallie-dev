"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

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
  sessionId: string;
  stageSlug: string;
};

type ArtifactTab = "rendered" | "raw" | "versions";
type CachedArtifactBody = Omit<SessionArtifactBody, "sanitizedHtml"> & {
  sanitizedHtml?: string | null;
};

const ARTIFACT_TABS: ArtifactTab[] = ["rendered", "raw", "versions"];
const ARTIFACT_VERSION_PARAM = "artifactVersion";

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

function ArtifactPanelCache({ sessionId, stageSlug, ...props }: ArtifactPanelProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [metadataCache] = useState(() => new Map<string, SessionArtifactMetadata[]>());
  const [bodyCache] = useState(() => new Map<string, CachedArtifactBody>());
  const [latestVersionCache] = useState(() => new Map<string, number>());
  const [trackedStageSlug, setTrackedStageSlug] = useState(stageSlug);
  const stageJustChanged = trackedStageSlug !== stageSlug;
  const currentStageKey = stageCacheKey(sessionId, stageSlug);

  // `artifactVersion` is stage-agnostic; clear it when the timeline selection changes so a
  // historical selection cannot leak into another stage's panel.
  useEffect(() => {
    if (!stageJustChanged) return;
    queueMicrotask(() => setTrackedStageSlug(stageSlug));
    if (!searchParams.has(ARTIFACT_VERSION_PARAM)) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete(ARTIFACT_VERSION_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams, stageJustChanged, stageSlug]);

  return (
    <ArtifactPanelStage
      key={currentStageKey}
      {...props}
      bodyCache={bodyCache}
      currentStageKey={currentStageKey}
      ignoreUrlVersion={stageJustChanged}
      latestVersionCache={latestVersionCache}
      metadataCache={metadataCache}
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
  sessionId,
  stageSlug,
}: ArtifactPanelProps & {
  bodyCache: Map<string, CachedArtifactBody>;
  currentStageKey: string;
  ignoreUrlVersion?: boolean;
  latestVersionCache: Map<string, number>;
  metadataCache: Map<string, SessionArtifactMetadata[]>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { pushToast } = useOptionalToast();

  const urlVersion = parseArtifactVersionParam(searchParams.get(ARTIFACT_VERSION_PARAM));
  const [activeTab, setActiveTab] = useState<ArtifactTab>("rendered");
  // URL is authoritative for shared links and back/forward; local state updates
  // immediately on click so the UI does not wait for the router replace echo.
  // When the stage just changed, ignore a leftover stage-agnostic URL version.
  const [suppressUrlVersion, setSuppressUrlVersion] = useState(ignoreUrlVersion);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(() =>
    ignoreUrlVersion ? null : urlVersion,
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
  const [metadata, setMetadata] = useState<SessionArtifactMetadata[] | null>(
    () => metadataCache.get(currentStageKey) ?? null,
  );
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

  function writeArtifactVersionToUrl(version: number | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (version === null || (latestVersion !== null && version === latestVersion)) {
      params.delete(ARTIFACT_VERSION_PARAM);
    } else {
      params.set(ARTIFACT_VERSION_PARAM, String(version));
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
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
        // Optimistic row for immediate UI, but invalidate the cache so Versions refetches
        // authoritative author/attempt/changes-requested metadata from the API.
        const nextMetadata = [
          {
            attempt: latestArtifact.version,
            authorLabel: "Agent",
            changesRequested: false,
            createdAt: latestArtifact.createdAt,
            stageSlug: latestArtifact.stageSlug,
            version: latestArtifact.version,
          },
          ...cachedMetadata,
        ].sort((left, right) => right.version - left.version);
        metadataCache.delete(currentStageKey);
        queueMicrotask(() => {
          setMetadata(nextMetadata);
          setMetadataRetry((value) => value + 1);
        });
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
    latestArtifact,
    latestVersionCache,
    loadLatest,
    metadataCache,
    sessionId,
    stageSlug,
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
    if (cached) {
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
        metadataCache.set(currentStageKey, result);
        setMetadata(result);
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
  }, [activeTab, currentStageKey, metadataCache, metadataRetry, sessionId, stageSlug]);

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
            <ul aria-labelledby="artifact-version-heading" className="space-y-2" role="listbox">
              {metadata.map((artifact) => {
                const isSelected = viewingVersion === artifact.version;
                const isLatest = artifact.version === latestVersion;
                return (
                  <li key={artifact.version} role="none">
                    <button
                      type="button"
                      aria-selected={isSelected}
                      className={cn(
                        "w-full rounded-[6px] border px-3 py-2.5 text-left transition-colors",
                        isSelected
                          ? "border-accent/40 bg-accent-soft"
                          : "border-border hover:border-border-strong hover:bg-control-muted/40",
                      )}
                      onClick={() => selectVersion(artifact.version)}
                      role="option"
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
