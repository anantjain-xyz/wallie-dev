"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { MetadataItem, MetadataList } from "@/components/ui/page-shell";

import {
  browserScreenshotAnchor,
  browserScreenshotDownloadPath,
  isBrowserScreenshotHash,
  type BrowserEvidenceSelection,
  type BrowserEvidenceReceipt,
  type BrowserScreenshotRecord,
} from "./browser-evidence-contracts";
import { useBrowserEvidence, useBrowserEvidenceHash } from "./browser-evidence-client";

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

export function BrowserScreenshotInspector({
  sessionId,
  runId,
  artifactId,
  artifactLinkQuery,
}: BrowserEvidenceSelection & { sessionId: string; artifactLinkQuery?: string }) {
  const sectionId = useId();
  const hash = useBrowserEvidenceHash();
  const [open, setOpen] = useState(false);
  const [dismissedHash, setDismissedHash] = useState("");
  const anchorOpen = hash !== dismissedHash && isBrowserScreenshotHash(hash);
  const expanded = open || anchorOpen;
  const { result, reset, retry } = useBrowserEvidence({ sessionId, runId, artifactId, expanded });

  useEffect(() => {
    if (anchorOpen && result && result !== "unavailable") {
      document.getElementById(hash.slice(1))?.scrollIntoView({ block: "nearest" });
    }
  }, [anchorOpen, hash, result]);

  const evidence = Array.isArray(result) ? result[0] : undefined;
  const screenshots = evidence?.records.filter(isScreenshot) ?? [];
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
        {expanded && Array.isArray(result) && !screenshots.length ? (
          <p role="status" className="text-sm text-muted">
            No screenshots were recorded for this run.
          </p>
        ) : null}
        {expanded && evidence && screenshots.length ? (
          <ul
            aria-label="Browser screenshots"
            className="min-w-0 divide-y divide-border border-y border-border"
          >
            {screenshots.map((record) => (
              <ScreenshotRecord
                key={record.key}
                record={record}
                evidence={evidence}
                sessionId={sessionId}
                artifactId={artifactId}
                artifactLinkQuery={artifactLinkQuery}
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
  sessionId,
  artifactId,
  artifactLinkQuery,
}: {
  record: BrowserScreenshotRecord;
  evidence: BrowserEvidenceReceipt;
  sessionId: string;
  artifactId?: string;
  artifactLinkQuery?: string;
}) {
  const captured = record.status === "captured" ? record : null;
  const anchor = captured ? browserScreenshotAnchor(captured.manifest.assetId) : undefined;
  return (
    <li id={anchor} className="min-w-0 scroll-mt-24 space-y-3 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <p className="min-w-0 break-all text-sm font-semibold text-foreground">{record.key}</p>
        <span className="text-xs text-muted">
          {captured
            ? "Recorded screenshot"
            : record.status === "failed"
              ? "Capture failed"
              : "Capture unavailable"}
        </span>
      </div>
      <MetadataList>
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
          <MetadataItem
            label="SHA-256"
            monospace
            value={<span className="break-all">{captured.manifest.sha256}</span>}
          />
        ) : null}
      </MetadataList>
      {record.status === "captured" ? (
        <>
          <ScreenshotPreview
            label={record.key}
            expectedBytes={record.manifest.sizeBytes}
            path={browserScreenshotDownloadPath(sessionId, record.manifest.assetId, {
              runId: evidence.runId,
              artifactId,
            })}
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
    </li>
  );
}

type Preview =
  | { status: "closed" | "loading" | "unavailable" }
  | { status: "ready"; url: string; width: number; height: number };

async function loadPng(path: string, expectedBytes: number, signal: AbortSignal) {
  const response = await fetch(path, { cache: "no-store", signal });
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
