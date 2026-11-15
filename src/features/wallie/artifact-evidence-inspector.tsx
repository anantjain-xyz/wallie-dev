"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import { workspaceRunDetailPath } from "@/lib/routes";
import { cn } from "@/lib/utils";
import {
  ArtifactEvidenceRequestError,
  fetchPrivateArtifact,
  inspectArtifact,
  loadArtifactPage,
  resolveArtifactScope,
  type ArtifactEvidenceSource,
  type ArtifactPage,
  type ArtifactScope,
  type ArtifactTarget,
  type InspectedArtifact,
} from "./artifact-evidence-inspector-data";
import type { RunArtifactAvailability, RunArtifactKind } from "./run-artifacts-contracts";

const KINDS = {
  stage_markdown: "Agent-authored output",
  checkpoint: "Retained checkpoint",
  validation_log: "Harness log",
  validation_report: "Harness report",
  validation_preview: "Harness preview evidence",
  validation_screenshot: "Harness screenshot evidence",
} satisfies Record<RunArtifactKind, string>;

const AVAILABILITY = {
  available: { label: "Available", help: "Download the verified file.", tone: "text-success" },
  recorded: {
    label: "Recorded",
    help: "Check availability to verify the stored content.",
    tone: "text-muted",
  },
  retained: {
    label: "Retained",
    help: "Use the checkpoint commit to trace the source. Wallie stores recovery bundles privately.",
    tone: "text-muted",
  },
  missing: {
    label: "Missing",
    help: "The stored file is missing. Run validation again to capture a new copy.",
    tone: "text-warning",
  },
  expired: {
    label: "Expired",
    help: "The file has expired. Run validation again to capture current evidence.",
    tone: "text-warning",
  },
  redacted: {
    label: "Redacted",
    help: "The file was withheld. Ask a workspace maintainer about access.",
    tone: "text-warning",
  },
  inaccessible: {
    label: "Inaccessible",
    help: "Wallie could not access the file. Ask a workspace maintainer to check storage and permissions.",
    tone: "text-danger",
  },
  integrity_mismatch: {
    label: "Integrity mismatch",
    help: "The file differs from its receipt. Run validation again or ask a maintainer to investigate.",
    tone: "text-danger",
  },
  unavailable: {
    label: "Unavailable",
    help: "Wallie could not check the file. Check availability again.",
    tone: "text-warning",
  },
} satisfies Record<RunArtifactAvailability, { label: string; help: string; tone: string }>;

function targetMatches(first: ArtifactTarget | null, second: ArtifactTarget) {
  return first?.id === second.id && first.kind === second.kind;
}

function requestFailure(error: unknown) {
  if (error instanceof ArtifactEvidenceRequestError && [401, 403, 404].includes(error.status)) {
    return "Wallie could not open this record. Confirm that you have access to the source run.";
  }
  return "Wallie could not load the artifact details. Try again.";
}

type ArtifactPanel = {
  scope: ArtifactScope;
  page: ArtifactPage | null;
  catalogOpen: boolean;
  hasPagedCatalog: boolean;
  selected: InspectedArtifact | null;
  target: ArtifactTarget | null;
  selectionFailure: string | null;
};

type InspectorView =
  | { kind: "closed" | "loading" | "legacy" }
  | { kind: "error"; message: string }
  | { kind: "panel"; value: ArtifactPanel };
type PendingAction = "opening" | "catalog" | "selecting" | "download";

function reflectSelection(panel: ArtifactPanel, selected: InspectedArtifact): ArtifactPanel {
  const page = panel.page;
  return {
    ...panel,
    selected,
    selectionFailure: null,
    page: page
      ? {
          ...page,
          items: page.items.map((item) => (targetMatches(item, selected) ? selected : item)),
        }
      : null,
  };
}

export function ArtifactEvidenceInspector({ source }: { source: ArtifactEvidenceSource }) {
  const sourceKey =
    source.kind === "review"
      ? `review:${source.sessionId}:${source.artifactId}`
      : `run:${source.workspaceId}:${source.runId}:${source.artifactId ?? ""}`;
  return <ScopedArtifactEvidence key={sourceKey} source={source} />;
}

function ScopedArtifactEvidence({ source }: { source: ArtifactEvidenceSource }) {
  const regionId = useId();
  const catalogId = useId();
  const [view, setView] = useState<InspectorView>({ kind: "closed" });
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const disclosureButton = useRef<HTMLButtonElement | null>(null);
  const detailsHeading = useRef<HTMLParagraphElement | null>(null);
  const retryLookupButton = useRef<HTMLButtonElement | null>(null);
  const removedControl = useRef<HTMLButtonElement | null>(null);
  const expanded = view.kind !== "closed";

  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    const control = removedControl.current;
    removedControl.current = null;
    if (control && !control.isConnected && document.activeElement === document.body) {
      (detailsHeading.current ?? retryLookupButton.current)?.focus();
    }
  }, [view]);

  function recoverFocusIfRemoved(opener?: HTMLButtonElement) {
    if (opener && document.activeElement === opener) removedControl.current = opener;
  }

  async function perform<T>(
    action: PendingAction,
    work: (signal: AbortSignal) => Promise<T>,
    success: (result: T) => void,
    failed: (error: unknown) => void,
  ) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setPending(action);
    setNotice(null);
    try {
      const result = await work(controller.signal);
      if (!controller.signal.aborted) success(result);
    } catch (error) {
      if (!controller.signal.aborted) failed(error);
    } finally {
      if (active.current === controller && !controller.signal.aborted) {
        active.current = null;
        setPending(null);
      }
    }
  }

  function open() {
    setView({ kind: "loading" });
    void perform(
      "opening",
      async (signal): Promise<InspectorView> => {
        const scope = await resolveArtifactScope(source, signal);
        if (signal.aborted) return { kind: "closed" };
        if (!scope) return { kind: "legacy" };
        const data: ArtifactPanel = {
          scope,
          page: null,
          catalogOpen: false,
          hasPagedCatalog: false,
          target: null,
          selected: null,
          selectionFailure: null,
        };
        if (source.artifactId) {
          data.target = { kind: "stage_markdown", id: source.artifactId };
          try {
            data.selected = await inspectArtifact(scope, data.target, signal);
          } catch (error) {
            data.selectionFailure = requestFailure(error);
          }
        } else {
          data.page = await loadArtifactPage(scope, signal);
          data.catalogOpen = true;
          data.hasPagedCatalog = Boolean(data.page.nextCursor);
        }
        return { kind: "panel", value: data };
      },
      setView,
      (error) => setView({ kind: "error", message: requestFailure(error) }),
    );
  }

  function toggle() {
    if (!expanded) {
      open();
      return;
    }
    active.current?.abort();
    active.current = null;
    setPending(null);
    setNotice(null);
    setView({ kind: "closed" });
  }

  function loadCatalog(panel: ArtifactPanel) {
    void perform(
      "catalog",
      (signal) => loadArtifactPage(panel.scope, signal, panel.page?.nextCursor ?? undefined),
      ({ items, nextCursor }) => {
        const known = new Map(panel.page?.items.map((item) => [`${item.kind}:${item.id}`, item]));
        for (const item of items) known.set(`${item.kind}:${item.id}`, item);
        setView({
          kind: "panel",
          value: {
            ...panel,
            catalogOpen: true,
            hasPagedCatalog: panel.hasPagedCatalog || Boolean(nextCursor),
            page: { items: [...known.values()], nextCursor },
          },
        });
      },
      (error) => setNotice(requestFailure(error)),
    );
  }

  function toggleCatalog(panel: ArtifactPanel) {
    if (pending) return;
    if (panel.page) {
      setView({ kind: "panel", value: { ...panel, catalogOpen: !panel.catalogOpen } });
    } else {
      loadCatalog(panel);
    }
  }

  function select(panel: ArtifactPanel, target: ArtifactTarget, opener?: HTMLButtonElement) {
    const next = {
      ...panel,
      target,
      selected: targetMatches(panel.selected, target) ? panel.selected : null,
      selectionFailure: targetMatches(panel.target, target) ? panel.selectionFailure : null,
    };
    setView({ kind: "panel", value: next });
    void perform(
      "selecting",
      (signal) => inspectArtifact(panel.scope, target, signal),
      (selected) => {
        recoverFocusIfRemoved(opener);
        setView({ kind: "panel", value: reflectSelection(next, selected) });
      },
      (error) => {
        recoverFocusIfRemoved(opener);
        setView({
          kind: "panel",
          value: { ...next, selected: null, selectionFailure: requestFailure(error) },
        });
      },
    );
  }

  function download(panel: ArtifactPanel, artifact: InspectedArtifact, opener: HTMLButtonElement) {
    void perform(
      "download",
      (signal) => fetchPrivateArtifact(panel.scope, artifact, signal),
      (result) => {
        if (result.kind === "blocked") {
          recoverFocusIfRemoved(opener);
          setView({
            kind: "panel",
            value: reflectSelection(panel, {
              ...artifact,
              availability: result.availability,
              downloadable: false,
            }),
          });
          return;
        }
        const url = URL.createObjectURL(result.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `wallie-${artifact.id}.${artifact.kind === "stage_markdown" ? "md" : "txt"}`;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice("Download started.");
      },
      (error) => setNotice(requestFailure(error)),
    );
  }

  const panel = view.kind === "panel" ? view.value : null;
  const selected = panel?.selected;
  return (
    <div className="min-w-0">
      <button
        aria-controls={regionId}
        aria-expanded={expanded}
        className="ui-button min-h-11 max-w-full"
        onClick={toggle}
        ref={disclosureButton}
        type="button"
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-muted", !expanded && "-rotate-90")}
        />
        Inspect artifact provenance
      </button>
      <div className="mt-3 min-w-0 space-y-4" hidden={!expanded} id={regionId}>
        {view.kind === "loading" ? (
          <p className="text-sm text-muted" role="status">
            Loading artifact provenance…
          </p>
        ) : null}
        {view.kind === "legacy" ? (
          <p className="text-sm text-muted" role="status">
            This artifact has no recorded producing run. Its Markdown is still available in this
            review.
          </p>
        ) : null}
        {view.kind === "error" ? (
          <div className="space-y-2">
            <p className="text-sm text-danger" role="alert">
              {view.message}
            </p>
            <button
              className="ui-button min-h-11"
              onClick={() => {
                disclosureButton.current?.focus();
                open();
              }}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : null}
        {panel ? (
          <>
            {selected ? (
              <ArtifactDetails
                artifact={selected}
                headingRef={detailsHeading}
                onCheck={(opener) => select(panel, selected, opener)}
                onDownload={(opener) => download(panel, selected, opener)}
                pending={pending}
                scope={panel.scope}
              />
            ) : null}
            {pending === "selecting" ? (
              <p className="text-sm text-muted" role="status">
                Checking artifact availability…
              </p>
            ) : null}
            {panel.selectionFailure && panel.target ? (
              <div className="space-y-2">
                <p className="text-sm text-danger" role="alert">
                  {panel.selectionFailure}
                </p>
                <button
                  aria-disabled={pending !== null}
                  className="ui-button min-h-11 aria-disabled:opacity-70"
                  onClick={(event) =>
                    !pending && panel.target && select(panel, panel.target, event.currentTarget)
                  }
                  ref={retryLookupButton}
                  type="button"
                >
                  Retry artifact lookup
                </button>
              </div>
            ) : null}
            {source.artifactId ? (
              <button
                aria-controls={catalogId}
                aria-disabled={pending !== null}
                aria-expanded={panel.catalogOpen}
                className="ui-button min-h-11 aria-disabled:opacity-70"
                onClick={() => toggleCatalog(panel)}
                type="button"
              >
                {panel.catalogOpen ? "Hide run artifacts" : "Browse run artifacts"}
              </button>
            ) : null}
            <div hidden={!panel.catalogOpen} id={catalogId}>
              {panel.catalogOpen && panel.page ? (
                <CatalogItems
                  hasPagedCatalog={panel.hasPagedCatalog}
                  page={panel.page}
                  pending={pending}
                  target={panel.target}
                  onSelect={(artifact) => select(panel, artifact)}
                  onNextPage={() => loadCatalog(panel)}
                />
              ) : null}
            </div>
            {pending === "catalog" ? (
              <p className="text-sm text-muted" role="status">
                Loading artifacts…
              </p>
            ) : null}
          </>
        ) : null}
        {notice ? (
          <p className="text-sm text-muted" role="status">
            {notice}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ArtifactDetails({
  artifact,
  headingRef,
  onCheck,
  onDownload,
  pending,
  scope,
}: {
  artifact: InspectedArtifact;
  headingRef: { current: HTMLParagraphElement | null };
  onCheck: (opener: HTMLButtonElement) => void;
  onDownload: (opener: HTMLButtonElement) => void;
  pending: PendingAction | null;
  scope: ArtifactScope;
}) {
  const availability = AVAILABILITY[artifact.availability];
  return (
    <div className="min-w-0 space-y-3 border-y border-border py-3">
      <div className="min-w-0 space-y-1" aria-live="polite">
        <p className="type-label text-muted">{KINDS[artifact.kind]}</p>
        <p
          className="break-words text-sm font-semibold text-foreground"
          ref={headingRef}
          tabIndex={-1}
        >
          {artifact.label}
        </p>
        <p className={cn("text-sm font-medium", availability.tone)}>{availability.label}</p>
        <p className="text-sm text-muted">{availability.help}</p>
      </div>
      <MetadataList>
        <MetadataItem label="Artifact ID" monospace value={<Identifier value={artifact.id} />} />
        <MetadataItem
          label="Producing run"
          monospace
          value={<Identifier value={artifact.producer.runId} />}
        />
        <MetadataItem label="Attempt" value={artifact.producer.attemptCount} />
        {artifact.digest ? (
          <MetadataItem
            label={artifact.digest.algorithm === "sha256" ? "SHA-256" : "Git commit"}
            monospace
            value={<Identifier value={artifact.digest.value} />}
          />
        ) : null}
        {artifact.checkpoint ? (
          <MetadataItem
            label="Checkpoint commit"
            monospace
            value={<Identifier value={artifact.checkpoint.commitSha} />}
          />
        ) : null}
        {artifact.validation ? (
          <>
            <MetadataItem
              label="Validation receipt run"
              monospace
              value={<Identifier value={artifact.validation.runId} />}
            />
            <MetadataItem
              label="Validated commit"
              monospace
              value={<Identifier value={artifact.validation.commitSha} />}
            />
            <MetadataItem
              label="Validation tree"
              monospace
              value={<Identifier value={artifact.validation.treeSha} />}
            />
          </>
        ) : null}
      </MetadataList>
      <div className="flex flex-wrap items-center gap-2">
        {artifact.downloadable && artifact.availability === "available" ? (
          <button
            aria-disabled={pending !== null}
            className="ui-button min-h-11 aria-disabled:opacity-70"
            onClick={(event) => !pending && onDownload(event.currentTarget)}
            type="button"
          >
            {pending === "download" ? "Downloading…" : "Download privately"}
          </button>
        ) : null}
        {["recorded", "missing", "inaccessible", "integrity_mismatch", "unavailable"].includes(
          artifact.availability,
        ) ? (
          <button
            aria-disabled={pending !== null}
            className="ui-button min-h-11 aria-disabled:opacity-70"
            onClick={(event) => !pending && onCheck(event.currentTarget)}
            type="button"
          >
            Check availability
          </button>
        ) : null}
        {scope.workspaceSlug ? (
          <a
            className="ui-button min-h-11"
            href={workspaceRunDetailPath(scope.workspaceSlug, artifact.producer.runId)}
          >
            Open producing run
          </a>
        ) : null}
      </div>
    </div>
  );
}

function Identifier({ value }: { value: string }) {
  return <span className="[overflow-wrap:anywhere]">{value}</span>;
}

function CatalogItems({
  hasPagedCatalog,
  page,
  pending,
  target,
  onSelect,
  onNextPage,
}: {
  hasPagedCatalog: boolean;
  page: ArtifactPage;
  pending: PendingAction | null;
  target: ArtifactTarget | null;
  onSelect: (artifact: ArtifactTarget) => void;
  onNextPage: () => void;
}) {
  if (!page.items.length) {
    return (
      <p className="text-sm text-muted" role="status">
        This run has no durable artifacts or evidence.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <ul aria-label="Artifacts from this run" className="divide-y divide-border">
        {page.items.map((item) => {
          const availability = AVAILABILITY[item.availability];
          return (
            <li
              key={`${item.kind}:${item.id}`}
              className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0"
            >
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-foreground">{item.label}</p>
                <p className="text-xs text-muted">
                  {KINDS[item.kind]} ·{" "}
                  <span className={availability.tone}>{availability.label}</span>
                </p>
              </div>
              <button
                aria-label={`Inspect ${item.label}`}
                aria-pressed={targetMatches(target, item)}
                className="ui-button min-h-11"
                disabled={pending === "catalog"}
                onClick={() => onSelect(item)}
                type="button"
              >
                Inspect
              </button>
            </li>
          );
        })}
      </ul>
      {hasPagedCatalog ? (
        <button
          aria-disabled={pending !== null || !page.nextCursor}
          className="ui-button min-h-11 aria-disabled:opacity-70"
          onClick={() => !pending && page.nextCursor && onNextPage()}
          type="button"
        >
          {page.nextCursor ? "Load more artifacts" : "All artifacts loaded"}
        </button>
      ) : null}
    </div>
  );
}
