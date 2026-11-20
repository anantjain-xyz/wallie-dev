"use client";

import { useEffect, useId, useRef, useState } from "react";

import { TimeDisplay } from "@/components/shared/time-display";
import { MetadataItem, MetadataList } from "@/components/ui/page-shell";

import { useBrowserEvidence, useBrowserEvidenceHash } from "./browser-evidence-client";
import {
  browserRecordingAnchor,
  browserRecordingDownloadPath,
  parseBrowserRecordingHash,
  RECORDING_EVIDENCE_PARAM,
  SCREENSHOT_EVIDENCE_PARAM,
  type BrowserEvidenceSelection,
  type BrowserRecordingFinding,
  type BrowserEvidenceReceipt,
  type BrowserVideoRecord,
} from "./browser-evidence-contracts";

const videoFailure = {
  runtime_unavailable: "The trusted recording runtime was unavailable.",
  tool_not_approved: "The browser tool was not approved for this attempt.",
  isolated_target_unavailable: "The isolated fixture was unavailable.",
  capture_failed: "The browser check did not retain a complete recording.",
  policy_excluded: "The recording did not meet the privacy policy.",
  source_changed: "The recording does not match the accepted source revision.",
};

type CapturedVideo = Extract<BrowserVideoRecord, { status: "captured" }>;

function findingsFor(evidence: BrowserEvidenceReceipt, record: CapturedVideo) {
  const findings = evidence.videoFindings?.filter(
    ({ assetId }) => assetId === record.manifest.assetId,
  );
  const steps = findings?.length === 1 ? findings[0]?.steps : undefined;
  const offsets = record.manifest.frameOffsetsMs;
  return steps?.length === offsets.length &&
    steps.every((step, index) => step.offsetMs === offsets[index])
    ? steps
    : null;
}

function formatOffset(milliseconds: number) {
  const seconds = milliseconds / 1000;
  return `0:${String(seconds).padStart(Number.isInteger(seconds) ? 2 : 4, "0")}`;
}

function findingLabel(step: BrowserRecordingFinding) {
  switch (step.action) {
    case "entry":
      return "Open fixture";
    case "click":
      return `Click ${step.testId}`;
    case "expectVisible":
      return `Verify ${step.testId} is visible`;
  }
}

function recordingLink(artifactLinkQuery: string | undefined, anchor: string) {
  if (!artifactLinkQuery) return `#${anchor}`;
  const query = new URLSearchParams(artifactLinkQuery);
  query.delete(SCREENSHOT_EVIDENCE_PARAM);
  query.set(RECORDING_EVIDENCE_PARAM, "1");
  return `?${query}#${anchor}`;
}

export function BrowserVideoInspector({
  sessionId,
  runId,
  artifactId,
  artifactLinkQuery,
}: BrowserEvidenceSelection & { sessionId: string; artifactLinkQuery?: string }) {
  const sectionId = useId();
  const hash = useBrowserEvidenceHash();
  const [open, setOpen] = useState(false);
  const [dismissedHash, setDismissedHash] = useState("");
  const target = hash === dismissedHash ? null : parseBrowserRecordingHash(hash);
  const expanded = open || target !== null;
  const { result, reset, retry } = useBrowserEvidence({ sessionId, runId, artifactId, expanded });
  const evidence = Array.isArray(result) ? result[0] : undefined;
  const recordings =
    evidence?.records.filter((record): record is BrowserVideoRecord => record.kind === "video") ??
    [];
  const linkedRecording =
    target &&
    evidence &&
    recordings.find((record) => {
      if (record.status !== "captured" || record.manifest.assetId !== target.assetId) return false;
      const steps = findingsFor(evidence, record);
      return (
        steps !== null &&
        (target.citation
          ? target.offsetMs < record.manifest.durationMs
          : steps.some((step) => step.offsetMs === target.offsetMs))
      );
    });

  useEffect(() => {
    if (linkedRecording)
      document.getElementById(hash.slice(1))?.scrollIntoView({ block: "nearest" });
  }, [hash, linkedRecording]);

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
        Browser recordings
      </button>
      <div id={sectionId} hidden={!expanded} className="mt-3 min-w-0">
        {expanded && result === null ? (
          <p role="status" className="text-sm text-muted">
            Loading recording evidence…
          </p>
        ) : null}
        {expanded && result === "unavailable" ? (
          <div className="space-y-2">
            <p role="status" className="text-sm text-muted">
              Recording evidence is unavailable.
            </p>
            <button type="button" className="ui-button min-h-11" onClick={retry}>
              Retry evidence lookup
            </button>
          </div>
        ) : null}
        {expanded && Array.isArray(result) && target && !linkedRecording ? (
          <p role="status" className="text-sm text-muted">
            The linked recording or capture time is unavailable.
          </p>
        ) : null}
        {expanded && Array.isArray(result) && !target && !recordings.length ? (
          <p role="status" className="text-sm text-muted">
            No recordings were captured for this run.
          </p>
        ) : null}
        {expanded && evidence && recordings.length ? (
          <ul
            aria-label="Browser recordings"
            className="min-w-0 divide-y divide-border border-y border-border"
          >
            {recordings.map((record) => (
              <RecordingReceipt
                key={record.key}
                record={record}
                evidence={evidence}
                sessionId={sessionId}
                artifactId={artifactId}
                artifactLinkQuery={artifactLinkQuery}
                citationAnchor={
                  linkedRecording === record && target?.citation ? hash.slice(1) : undefined
                }
                offsetMs={linkedRecording === record ? target?.offsetMs : undefined}
                findingHash={linkedRecording === record ? hash : undefined}
                onReselectFinding={() => setDismissedHash("")}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function RecordingReceipt({
  record,
  evidence,
  sessionId,
  artifactId,
  artifactLinkQuery,
  citationAnchor,
  offsetMs,
  findingHash,
  onReselectFinding,
}: {
  record: BrowserVideoRecord;
  evidence: BrowserEvidenceReceipt;
  sessionId: string;
  artifactId?: string;
  artifactLinkQuery?: string;
  citationAnchor?: string;
  offsetMs?: number;
  findingHash?: string;
  onReselectFinding: () => void;
}) {
  const captured = record.status === "captured" ? record : null;
  const steps = captured ? findingsFor(evidence, captured) : null;
  const [seekRequest, setSeekRequest] = useState(0);
  return (
    <li className="min-w-0 scroll-mt-24 space-y-3 py-3" id={citationAnchor}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <p className="min-w-0 break-all text-sm font-semibold text-foreground">{record.key}</p>
        <span className="text-xs text-muted">
          {captured && steps
            ? "Complete capture"
            : record.status === "unavailable"
              ? "Capture unavailable"
              : "Capture incomplete"}
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
        {captured ? (
          <>
            <MetadataItem
              label="Started"
              value={<TimeDisplay value={captured.startedAt} initialNow={captured.startedAt} />}
            />
            <MetadataItem
              label="Completed"
              value={<TimeDisplay value={captured.completedAt} initialNow={captured.completedAt} />}
            />
            <MetadataItem label="Duration" value={formatOffset(captured.manifest.durationMs)} />
            <MetadataItem
              label="SHA-256"
              monospace
              value={<span className="break-all">{captured.manifest.sha256}</span>}
            />
          </>
        ) : (
          <MetadataItem
            label="Recorded"
            value={<TimeDisplay value={evidence.createdAt} initialNow={evidence.createdAt} />}
          />
        )}
      </MetadataList>
      {captured && steps ? (
        <>
          <RecordingPreview
            key={captured.manifest.assetId}
            label={record.key}
            manifest={captured.manifest}
            path={browserRecordingDownloadPath(sessionId, captured.manifest.assetId, {
              runId: evidence.runId,
              artifactId,
            })}
            offsetMs={offsetMs}
            findingKey={findingHash === undefined ? undefined : `${findingHash}:${seekRequest}`}
            seekRequest={seekRequest}
          />
          <ol aria-label="Recorded steps" className="min-w-0 space-y-1">
            {steps.map((step) => {
              const anchor = browserRecordingAnchor(captured.manifest.assetId, step.offsetMs);
              return (
                <li key={step.offsetMs} className="min-w-0">
                  <a
                    id={anchor}
                    className="inline-flex min-h-11 max-w-full scroll-mt-24 items-center gap-2 text-sm text-accent underline aria-[current=location]:font-semibold"
                    href={recordingLink(artifactLinkQuery, anchor)}
                    aria-current={step.offsetMs === offsetMs ? "location" : undefined}
                    onClick={(event) => {
                      if (
                        event.button === 0 &&
                        !event.altKey &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.shiftKey &&
                        window.location.hash === `#${anchor}`
                      ) {
                        onReselectFinding();
                        setSeekRequest((value) => value + 1);
                      }
                    }}
                  >
                    <span className="shrink-0 font-mono">{formatOffset(step.offsetMs)}</span>
                    <span className="min-w-0 wrap-anywhere">{findingLabel(step)}</span>
                  </a>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <p role="status" className="text-sm text-muted">
          {record.status === "captured" ? videoFailure.capture_failed : videoFailure[record.reason]}
        </p>
      )}
    </li>
  );
}

type VideoManifest = CapturedVideo["manifest"];

function RecordingPreview({
  path,
  manifest,
  label,
  offsetMs,
  findingKey,
  seekRequest,
}: {
  path: string;
  manifest: VideoManifest;
  label: string;
  offsetMs?: number;
  findingKey?: string;
  seekRequest: number;
}) {
  const previewId = useId();
  const [open, setOpen] = useState(false);
  const [dismissedFinding, setDismissedFinding] = useState<string>();
  const showForFinding = findingKey !== undefined && findingKey !== dismissedFinding;
  const expanded = open || showForFinding;
  return (
    <>
      <button
        type="button"
        className="ui-button min-h-11"
        aria-controls={previewId}
        aria-expanded={expanded}
        onClick={() => {
          setOpen(!expanded);
          setDismissedFinding(expanded ? findingKey : undefined);
        }}
      >
        {expanded ? "Hide recording" : "Load recording"}
      </button>
      <div id={previewId} hidden={!expanded} className="min-w-0">
        {expanded ? (
          <RecordingPlayer
            path={path}
            label={label}
            manifest={manifest}
            offsetMs={offsetMs}
            seekRequest={seekRequest}
          />
        ) : null}
      </div>
    </>
  );
}

async function loadRecording(path: string, expectedBytes: number, signal: AbortSignal) {
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok || response.headers.get("content-type") !== "video/webm") return null;
  const blob = await response.blob();
  if (blob.size !== expectedBytes || blob.size < 4) return null;
  const header = new DataView(await blob.slice(0, 4).arrayBuffer());
  return header.getUint32(0) === 0x1a45dfa3 ? blob : null;
}

function RecordingPlayer({
  path,
  label,
  manifest,
  offsetMs,
  seekRequest,
}: {
  path: string;
  label: string;
  manifest: VideoManifest;
  offsetMs?: number;
  seekRequest: number;
}) {
  const media = useRef<HTMLVideoElement>(null);
  const objectUrl = useRef<string | null>(null);
  const [url, setUrl] = useState<string | "unavailable" | null>(null);
  const [request, setRequest] = useState(0);

  function revoke() {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    void (async () => {
      try {
        const blob = await loadRecording(path, manifest.sizeBytes, signal);
        if (controller.signal.aborted) return;
        if (!blob || signal.aborted) {
          setUrl("unavailable");
          return;
        }
        objectUrl.current = URL.createObjectURL(blob);
        setUrl(objectUrl.current);
      } catch {
        if (!controller.signal.aborted) setUrl("unavailable");
      }
    })();
    return () => {
      controller.abort();
      revoke();
    };
  }, [manifest.sizeBytes, path, request]);

  useEffect(() => {
    const video = media.current;
    if (video && video.readyState >= video.HAVE_METADATA && offsetMs !== undefined) {
      video.pause();
      video.currentTime = offsetMs / 1000;
    }
  }, [offsetMs, seekRequest, url]);

  function unavailable() {
    revoke();
    setUrl("unavailable");
  }

  if (!url)
    return (
      <p role="status" className="text-sm text-muted">
        Loading private recording…
      </p>
    );
  if (url === "unavailable") {
    return (
      <div className="space-y-2">
        <p role="status" className="text-sm text-muted">
          Recording unavailable. The capture receipt is still available.
        </p>
        <button
          type="button"
          className="ui-button min-h-11"
          onClick={() => {
            setUrl(null);
            setRequest((value) => value + 1);
          }}
        >
          Retry recording
        </button>
      </div>
    );
  }
  return (
    <video
      ref={media}
      aria-label={`Recording captured for ${label}`}
      className="block h-auto max-w-full rounded-md border border-border bg-black"
      width={Math.max(252, manifest.widthPx)}
      style={{ aspectRatio: `${manifest.widthPx}/${manifest.heightPx}` }}
      src={url}
      controls
      muted
      playsInline
      preload="metadata"
      onError={unavailable}
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        if (
          !Number.isFinite(video.duration) ||
          Math.abs(video.duration * 1000 - manifest.durationMs) > 10 ||
          video.videoWidth !== manifest.widthPx ||
          video.videoHeight !== manifest.heightPx
        ) {
          unavailable();
          return;
        }
        if (offsetMs !== undefined) video.currentTime = offsetMs / 1000;
      }}
    />
  );
}
