"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { MetadataItem, MetadataList } from "@/components/ui/page-shell";

import {
  browserScreenshotAnchor,
  browserAssetPathForScope,
  browserEvidenceAnchorForScope,
  browserEvidenceHashForScope,
  isBrowserScreenshotHash,
  type BrowserEvidenceInspectorProps,
  type BrowserEvidenceReceipt,
  type BrowserScreenshotRecord,
} from "./browser-evidence-contracts";
import {
  fetchBrowserEvidenceAsset,
  useBrowserEvidence,
  useBrowserEvidenceHash,
} from "./browser-evidence-client";

const reasonLabels = {
  runtime_unavailable: "The trusted capture runtime was unavailable.",
  tool_not_approved: "The browser tool was not approved for this attempt.",
  isolated_target_unavailable: "The isolated fixture was unavailable.",
  capture_failed: "The browser check did not retain an image.",
  policy_excluded: "The capture did not meet the privacy policy.",
  source_changed: "The capture does not match the accepted source revision.",
};

function isScreenshot(
  record: BrowserEvidenceReceipt["records"][number],
): record is BrowserScreenshotRecord {
  return record.kind === "screenshot";
}

export function BrowserScreenshotInspector(scope: BrowserEvidenceInspectorProps) {
  const sectionId = useId();
  const side = scope.trial?.side;
  const hash = browserEvidenceHashForScope(useBrowserEvidenceHash(), side);
  const [open, setOpen] = useState(false);
  const [dismissedHash, setDismissedHash] = useState("");
  const anchorOpen = hash !== dismissedHash && isBrowserScreenshotHash(hash);
  const expanded = open || anchorOpen;
  const { result, reset, retry } = useBrowserEvidence(scope, expanded);

  useEffect(() => {
    if (anchorOpen && result && result !== "unavailable") {
      document
        .getElementById(browserEvidenceAnchorForScope(hash.slice(1), side))
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [anchorOpen, hash, result, side]);

  const evidence = Array.isArray(result) ? result[0] : undefined;
  const screenshots = evidence?.records.filter(isScreenshot) ?? [];
  const linkedScreenshotMissing =
    side &&
    anchorOpen &&
    Array.isArray(result) &&
    !screenshots.some(
      (record) =>
        record.status === "captured" &&
        `#${browserScreenshotAnchor(record.manifest.assetId)}` === hash,
    );
  return (
    <section className="mt-2 min-w-0">
      <button
        type="button"
        className="ui-button min-h-11 max-w-full"
        aria-controls={sectionId}
        aria-expanded={expanded}
        onClick={() => {
          setOpen(!expanded);
          if (expanded) setDismissedHash(hash);
          reset();
        }}
      >
        Browser screenshots
      </button>
      <div id={sectionId} hidden={!expanded} className="mt-3 min-w-0">
        {expanded && result === null ? (
          <p role="status" className="text-sm text-muted">
            Loading screenshot evidence…
          </p>
        ) : null}
        {expanded && result === "unavailable" ? (
          <div className="space-y-2">
            <p role="status" className="text-sm text-muted">
              Screenshot evidence is unavailable.
            </p>
            <button type="button" className="ui-button min-h-11" onClick={retry}>
              Retry evidence lookup
            </button>
          </div>
        ) : null}
        {linkedScreenshotMissing ? (
          <p role="status" className="text-sm text-muted">
            The linked screenshot is unavailable.
          </p>
        ) : null}
        {expanded && Array.isArray(result) && !linkedScreenshotMissing && !screenshots.length ? (
          <p role="status" className="text-sm text-muted">
            No screenshots were recorded for this run.
          </p>
        ) : null}
        {expanded && evidence && screenshots.length ? (
          <ul
            aria-label="Browser screenshots"
            className="min-w-0 divide-y divide-border border-y border-border"
          >
            {screenshots.map((record, index) => (
              <ScreenshotRecord
                key={record.key}
                record={record}
                evidence={evidence}
                scope={scope}
                number={index + 1}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function ScreenshotRecord({
  record,
  evidence,
  scope,
  number,
}: {
  record: BrowserScreenshotRecord;
  evidence: BrowserEvidenceReceipt;
  scope: BrowserEvidenceInspectorProps;
  number: number;
}) {
  const captured = record.status === "captured" ? record : null;
  const anchor = captured
    ? browserEvidenceAnchorForScope(
        browserScreenshotAnchor(captured.manifest.assetId),
        scope.trial?.side,
      )
    : undefined;
  const { artifactLinkQuery } = scope;
  const trial = scope.trial;
  const label = trial
    ? `${trial.side === "original" ? "Original" : "Output"} screenshot ${number}`
    : record.key;
  const receipt = (
    <MetadataList className="[overflow-wrap:anywhere]">
      {trial ? <MetadataItem label="Check key" monospace value={record.key} /> : null}
      <MetadataItem
        label="Fixture path"
        monospace
        value={<span className="break-all">{record.path}</span>}
      />
      <MetadataItem
        label="Producing run"
        monospace
        value={<span className="break-all">{evidence.runId}</span>}
      />
      <MetadataItem label="Attempt" value={evidence.attemptCount} />
      <MetadataItem
        label="Validated commit"
        monospace
        value={<span className="break-all">{evidence.commitSha}</span>}
      />
      <MetadataItem
        label="Validation tree"
        monospace
        value={<span className="break-all">{evidence.treeSha}</span>}
      />
      <MetadataItem
        label="Recorded"
        value={<TimeDisplay value={evidence.createdAt} initialNow={evidence.createdAt} />}
      />
      {captured ? (
        <>
          {trial ? (
            <MetadataItem label="Asset ID" monospace value={captured.manifest.assetId} />
          ) : null}
          <MetadataItem
            label="SHA-256"
            monospace
            value={<span className="break-all">{captured.manifest.sha256}</span>}
          />
        </>
      ) : null}
    </MetadataList>
  );
  return (
    <li id={anchor} className="min-w-0 scroll-mt-24 space-y-3 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">
          {label}
        </p>
        <span className="text-xs text-muted">
          {captured
            ? "Recorded screenshot"
            : record.status === "failed"
              ? "Capture failed"
              : "Capture unavailable"}
        </span>
      </div>
      {trial ? (
        <p className="type-annotation text-muted">
          Attempt {evidence.attemptCount} ·{" "}
          <TimeDisplay value={evidence.createdAt} initialNow={evidence.createdAt} />
        </p>
      ) : (
        receipt
      )}
      {record.status === "captured" ? (
        <>
          <ScreenshotPreview
            label={label}
            expectedBytes={record.manifest.sizeBytes}
            path={browserAssetPathForScope(
              scope,
              "screenshot",
              evidence.runId,
              record.manifest.assetId,
            )}
          />
          <a
            className="text-xs text-accent underline"
            href={`${artifactLinkQuery ? `?${artifactLinkQuery}` : ""}#${anchor}`}
          >
            Link to screenshot evidence
          </a>
        </>
      ) : (
        <p className="text-sm text-muted">{reasonLabels[record.reason]}</p>
      )}
      {trial ? (
        <details className="rounded-md border border-border px-3 py-2">
          <summary className="type-label cursor-pointer">Exact capture receipt</summary>
          {receipt}
        </details>
      ) : null}
    </li>
  );
}

type Preview =
  | { status: "closed" | "loading" | "unavailable" | "expired" | "erased" }
  | { status: "ready"; url: string; width: number; height: number };

async function loadPng(path: string, expectedBytes: number, signal: AbortSignal) {
  const response = await fetchBrowserEvidenceAsset(path, signal);
  if (typeof response === "string") return response;
  if (!response.ok || response.headers.get("content-type") !== "image/png") return null;
  const blob = await response.blob();
  if (blob.size !== expectedBytes || blob.size < 24) return null;
  const header = new DataView(await blob.slice(0, 24).arrayBuffer());
  if (
    header.getUint32(0) !== 0x89504e47 ||
    header.getUint32(4) !== 0x0d0a1a0a ||
    header.getUint32(8) !== 13 ||
    header.getUint32(12) !== 0x49484452
  )
    return null;
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  return width > 0 && width <= 960 && height > 0 && height <= 540 ? { blob, width, height } : null;
}

function ScreenshotPreview({
  path,
  expectedBytes,
  label,
}: {
  path: string;
  expectedBytes: number;
  label: string;
}) {
  const previewId = useId();
  const [preview, setPreview] = useState<Preview>({ status: "closed" });
  const controller = useRef<AbortController | null>(null);
  const imageUrl = useRef<string | null>(null);
  function clear() {
    controller.current?.abort();
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = null;
  }
  useEffect(() => clear, []);
  const open = preview.status === "loading" || preview.status === "ready";

  async function toggle() {
    clear();
    if (open) {
      setPreview({ status: "closed" });
      return;
    }
    const request = new AbortController();
    controller.current = request;
    setPreview({ status: "loading" });
    try {
      const png = await loadPng(path, expectedBytes, request.signal);
      if (request.signal.aborted) return;
      if (typeof png === "string") {
        setPreview({ status: png });
        return;
      }
      if (!png) {
        setPreview({ status: "unavailable" });
        return;
      }
      const url = URL.createObjectURL(png.blob);
      imageUrl.current = url;
      setPreview({ status: "ready", url, width: png.width, height: png.height });
    } catch {
      if (!request.signal.aborted) setPreview({ status: "unavailable" });
    }
  }

  return (
    <>
      <button
        type="button"
        className="ui-button min-h-11"
        aria-controls={previewId}
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        {open
          ? "Hide screenshot"
          : preview.status === "unavailable"
            ? "Retry screenshot"
            : "View screenshot"}
      </button>
      <div id={previewId} aria-live="polite">
        {preview.status === "loading" ? (
          <p className="text-sm text-muted">Loading screenshot…</p>
        ) : null}
        {preview.status === "unavailable" ? (
          <p className="text-sm text-muted">
            Screenshot unavailable. The capture receipt is still available.
          </p>
        ) : null}
        {preview.status === "expired" || preview.status === "erased" ? (
          <p className="text-sm text-muted">
            {preview.status === "expired"
              ? "This screenshot expired under the workspace retention policy."
              : "This screenshot was erased."}
          </p>
        ) : null}
        {preview.status === "ready" ? (
          <figure className="min-w-0 space-y-2">
            <Image
              unoptimized
              src={preview.url}
              width={preview.width}
              height={preview.height}
              alt={`Screenshot captured for ${label}`}
              className="h-auto max-w-full rounded-md border border-border"
              onError={() => {
                clear();
                setPreview({ status: "unavailable" });
              }}
            />
            <figcaption className="text-xs text-muted">
              Private screenshot verified against the recorded digest.
            </figcaption>
          </figure>
        ) : null}
      </div>
    </>
  );
}
