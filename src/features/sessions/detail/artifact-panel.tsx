"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Spinner } from "@/components/shared/spinner";
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
  isDrafting: boolean;
  latestArtifact: SessionArtifactSummary | null;
  loadLatest: boolean;
  sessionId: string;
  stageSlug: string;
};

type ArtifactTab = "artifact" | "versions";
type ArtifactDisplayMode = "formatted" | "raw";
type CachedArtifactBody = Omit<SessionArtifactBody, "sanitizedHtml"> & {
  sanitizedHtml?: string | null;
};

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
    value.every(
      (artifact) =>
        !!artifact &&
        typeof artifact === "object" &&
        typeof (artifact as SessionArtifactMetadata).createdAt === "string" &&
        typeof (artifact as SessionArtifactMetadata).stageSlug === "string" &&
        typeof (artifact as SessionArtifactMetadata).version === "number",
    )
  );
}

export function ArtifactPanel(props: ArtifactPanelProps) {
  return <ArtifactPanelCache key={props.sessionId} {...props} />;
}

function ArtifactPanelCache({ sessionId, stageSlug, ...props }: ArtifactPanelProps) {
  const [metadataCache] = useState(() => new Map<string, SessionArtifactMetadata[]>());
  const [bodyCache] = useState(() => new Map<string, CachedArtifactBody>());
  const [latestVersionCache] = useState(() => new Map<string, number>());
  const currentStageKey = stageCacheKey(sessionId, stageSlug);

  return (
    <ArtifactPanelStage
      key={currentStageKey}
      {...props}
      bodyCache={bodyCache}
      currentStageKey={currentStageKey}
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
  initialFormattedArtifact,
  initialFormattedArtifactKey,
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
  latestVersionCache: Map<string, number>;
  metadataCache: Map<string, SessionArtifactMetadata[]>;
}) {
  const [activeTab, setActiveTab] = useState<ArtifactTab>("artifact");
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
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [selectedBody, setSelectedBody] = useState<CachedArtifactBody | null>(null);
  const [selectedBodyLoading, setSelectedBodyLoading] = useState(false);
  const [selectedBodyError, setSelectedBodyError] = useState<string | null>(null);
  const [selectedBodyRetry, setSelectedBodyRetry] = useState(0);
  const metadataController = useRef<AbortController | null>(null);
  const bodyController = useRef<AbortController | null>(null);
  const artifactTabRef = useRef<HTMLButtonElement>(null);
  const versionsTabRef = useRef<HTMLButtonElement>(null);
  const latestArtifactKey = latestArtifact
    ? artifactBodyCacheKey(sessionId, latestArtifact.stageSlug, latestArtifact.version)
    : null;

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
      if (cachedMetadata) {
        const nextMetadata = [
          {
            createdAt: latestArtifact.createdAt,
            stageSlug: latestArtifact.stageSlug,
            version: latestArtifact.version,
          },
          ...cachedMetadata.filter((artifact) => artifact.version !== latestArtifact.version),
        ].sort((left, right) => right.version - left.version);
        metadataCache.set(currentStageKey, nextMetadata);
        queueMicrotask(() => setMetadata(nextMetadata));
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
    if (activeTab !== "artifact") return;

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
    bodyController.current?.abort();
    bodyController.current = controller;
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
    activeTab,
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
        setSelectedVersion(result[0]?.version ?? null);
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

  useEffect(() => {
    if (activeTab !== "versions" || selectedVersion === null) return;
    const key = artifactBodyCacheKey(sessionId, stageSlug, selectedVersion);
    const cached = bodyCache.get(key);
    const canUseCached =
      cached &&
      (typeof cached.payload !== "string" ||
        typeof cached.sanitizedHtml === "string" ||
        key === initialFormattedArtifactKey);
    if (canUseCached) {
      return;
    }

    const controller = new AbortController();
    bodyController.current?.abort();
    bodyController.current = controller;
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setSelectedBodyLoading(true);
      setSelectedBodyError(null);
    });

    void fetch(
      `/api/sessions/${sessionId}/artifacts?stage=${encodeURIComponent(stageSlug)}&version=${selectedVersion}`,
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
    selectedVersion,
    sessionId,
    stageSlug,
  ]);

  function selectTab(tab: ArtifactTab) {
    setActiveTab(tab);
    if (tab === "versions" && selectedVersion === null) {
      setSelectedVersion(metadata?.[0]?.version ?? null);
    }
  }

  function selectVersion(version: number) {
    setSelectedVersion(version);
    setSelectedBody(null);
    setSelectedBodyError(null);
    setSelectedBodyLoading(false);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab: ArtifactTab =
      event.key === "ArrowRight" || event.key === "End" ? "versions" : "artifact";
    selectTab(nextTab);
    (nextTab === "artifact" ? artifactTabRef : versionsTabRef).current?.focus();
  }

  const cachedSelectedBody =
    selectedVersion === null
      ? null
      : (bodyCache.get(artifactBodyCacheKey(sessionId, stageSlug, selectedVersion)) ?? null);
  const visibleSelectedBody =
    selectedBody?.version === selectedVersion ? selectedBody : cachedSelectedBody;

  return (
    <div>
      <div aria-label="Artifact views" className="mb-3 flex gap-1" role="tablist">
        <TabButton
          active={activeTab === "artifact"}
          controls="artifact-current-panel"
          onClick={() => selectTab("artifact")}
          onKeyDown={handleTabKeyDown}
          ref={artifactTabRef}
        >
          Artifact
        </TabButton>
        <TabButton
          active={activeTab === "versions"}
          controls="artifact-versions-panel"
          onClick={() => selectTab("versions")}
          onKeyDown={handleTabKeyDown}
          ref={versionsTabRef}
        >
          Versions
        </TabButton>
      </div>

      {activeTab === "artifact" ? (
        <div aria-labelledby="artifact-tab" id="artifact-current-panel" role="tabpanel">
          {isDrafting && latestBody ? (
            <ProgressHint text="Wallie is drafting the next artifact version." />
          ) : null}
          {latestError ? (
            <FailureHint
              message={latestError}
              onRetry={() => setLatestRetry((value) => value + 1)}
            />
          ) : null}
          {latestLoading ? <ProgressHint text="Loading the artifact." /> : null}
          {latestBody ? (
            <ArtifactBodyView
              artifact={latestBody}
              initialFormattedArtifact={initialFormattedArtifact}
              initialFormattedArtifactKey={initialFormattedArtifactKey}
              sessionId={sessionId}
            />
          ) : latestLoading ? null : isDrafting ? (
            <ProgressHint text="Wallie is drafting the artifact for this stage." />
          ) : !latestError ? (
            <EmptyHint text={emptyText} />
          ) : null}
        </div>
      ) : (
        <div aria-labelledby="versions-tab" id="artifact-versions-panel" role="tabpanel">
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
            <>
              <div className="mb-3 flex flex-wrap gap-2" aria-label="Artifact versions">
                {metadata.map((artifact) => (
                  <button
                    key={artifact.version}
                    type="button"
                    aria-pressed={selectedVersion === artifact.version}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs font-medium",
                      selectedVersion === artifact.version
                        ? "border-accent/40 bg-accent-soft text-accent"
                        : "border-border text-muted hover:text-foreground",
                    )}
                    onClick={() => selectVersion(artifact.version)}
                  >
                    v{artifact.version}
                  </button>
                ))}
              </div>
              {selectedBodyLoading && !visibleSelectedBody ? (
                <ProgressHint text={`Loading version ${selectedVersion}.`} />
              ) : null}
              {selectedBodyError ? (
                <FailureHint
                  message={selectedBodyError}
                  onRetry={() => setSelectedBodyRetry((value) => value + 1)}
                />
              ) : null}
              {visibleSelectedBody ? (
                <ArtifactBodyView
                  artifact={visibleSelectedBody}
                  initialFormattedArtifact={initialFormattedArtifact}
                  initialFormattedArtifactKey={initialFormattedArtifactKey}
                  sessionId={sessionId}
                />
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

type TabButtonProps = {
  active: boolean;
  children: ReactNode;
  controls: string;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  ref: React.Ref<HTMLButtonElement>;
};

function TabButton({ active, children, controls, onClick, onKeyDown, ref }: TabButtonProps) {
  const id = controls === "artifact-current-panel" ? "artifact-tab" : "versions-tab";
  return (
    <button
      ref={ref}
      aria-controls={controls}
      aria-selected={active}
      className={cn(
        "rounded-[4px] px-2.5 py-1 text-xs font-medium",
        active ? "bg-surface-muted text-foreground" : "text-muted hover:text-foreground",
      )}
      id={id}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      {children}
    </button>
  );
}

function ArtifactBodyView({
  artifact,
  initialFormattedArtifact,
  initialFormattedArtifactKey,
  sessionId,
}: {
  artifact: CachedArtifactBody;
  initialFormattedArtifact: ReactNode | null;
  initialFormattedArtifactKey: string | null;
  sessionId: string;
}) {
  const [displayMode, setDisplayMode] = useState<ArtifactDisplayMode>("formatted");
  const formatted = useMemo(() => {
    if (typeof artifact.payload === "string") return artifact.payload;
    try {
      return JSON.stringify(artifact.payload, null, 2);
    } catch {
      return String(artifact.payload);
    }
  }, [artifact.payload]);
  const isMarkdown = typeof artifact.payload === "string";
  const key = artifactBodyCacheKey(sessionId, artifact.stageSlug, artifact.version);
  const serverTree = key === initialFormattedArtifactKey ? initialFormattedArtifact : null;

  function handleDisplayKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setDisplayMode(event.key === "ArrowRight" || event.key === "End" ? "raw" : "formatted");
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="type-annotation uppercase tracking-wide text-muted">
          v{artifact.version} · {new Date(artifact.createdAt).toLocaleString()}
        </p>
        {isMarkdown ? (
          <div aria-label="Artifact format" className="flex gap-1" role="tablist">
            {(["formatted", "raw"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-selected={displayMode === mode}
                className={cn(
                  "rounded-[4px] px-2 py-1 text-xs font-medium capitalize",
                  displayMode === mode
                    ? "bg-surface-muted text-foreground"
                    : "text-muted hover:text-foreground",
                )}
                onClick={() => setDisplayMode(mode)}
                onKeyDown={handleDisplayKeyDown}
                role="tab"
                tabIndex={displayMode === mode ? 0 : -1}
              >
                {mode}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {isMarkdown && displayMode === "formatted" ? (
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
            "max-h-[480px] overflow-auto whitespace-pre-wrap rounded-[4px] p-3 text-xs leading-5 text-foreground",
            !isMarkdown && "bg-background",
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
