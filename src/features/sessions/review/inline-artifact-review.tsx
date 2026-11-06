"use client";

import dynamic from "next/dynamic";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { OPEN_REVIEW_COMMENTS_EVENT } from "./open-comments";
import { artifactSourceBlocks, selectedArtifactSourceAnchor } from "./selection";
import type { ArtifactSourceAnchor } from "./source-anchor";

const ArtifactReviewPanel = dynamic(
  () => import("./review-panel").then((module) => module.ArtifactReviewPanel),
  {
    loading: () => (
      <p role="status" className="p-3 text-xs text-muted">
        Loading comments…
      </p>
    ),
  },
);

export function InlineArtifactReview({
  sessionId,
  artifactId,
  artifactVersion,
  source,
  historical,
  readOnly,
  children,
}: {
  sessionId: string;
  artifactId: string;
  artifactVersion: number;
  source: string;
  historical: boolean;
  readOnly: boolean;
  children: ReactNode;
}) {
  const [panelState, setPanelState] = useState<"unopened" | "open" | "hidden">("unopened");
  const open = panelState === "open";
  const [selection, setSelection] = useState<ArtifactSourceAnchor | null>(null);
  const [anchor, setAnchor] = useState<ArtifactSourceAnchor | null>(null);
  const [block, setBlock] = useState(0);
  const reader = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const blocks = useMemo(() => (open ? artifactSourceBlocks(source) : []), [open, source]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("reviewThread")) {
      queueMicrotask(() => setPanelState("open"));
    }
    const openComments = () => setPanelState("open");
    window.addEventListener(OPEN_REVIEW_COMMENTS_EVENT, openComments);
    return () => window.removeEventListener(OPEN_REVIEW_COMMENTS_EVENT, openComments);
  }, []);

  function captureSelection() {
    if (reader.current && !readOnly) {
      setSelection(selectedArtifactSourceAnchor(reader.current, source));
    }
  }
  function beginComment(value: ArtifactSourceAnchor) {
    setAnchor(value);
    setPanelState("open");
  }

  return (
    <div className={open ? "grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]" : "min-w-0"}>
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <button
            ref={opener}
            id="artifact-review-open"
            type="button"
            aria-expanded={open}
            aria-controls="artifact-review-panel"
            className="min-h-11 rounded-[4px] border border-border px-3 text-xs font-medium hover:bg-control-muted"
            onClick={() => setPanelState((value) => (value === "open" ? "hidden" : "open"))}
          >
            Comments
          </button>
          {!readOnly ? (
            <button
              type="button"
              disabled={!selection}
              className="min-h-11 rounded-[4px] px-3 text-xs font-medium text-accent disabled:text-muted"
              onClick={() => {
                if (selection) beginComment(selection);
              }}
            >
              Comment on selection
            </button>
          ) : (
            <p className="text-xs text-muted">Archived session · Comments are read-only</p>
          )}
        </div>
        {open && !readOnly ? (
          <div className="mb-4 space-y-2 rounded-[4px] border border-border bg-canvas p-3">
            <label className="block text-xs font-medium" htmlFor="artifact-comment-block">
              Comment on a block
            </label>
            <div className="flex flex-wrap gap-2">
              <select
                id="artifact-comment-block"
                className="min-h-11 min-w-0 flex-1 rounded-[4px] border border-border bg-surface px-2 text-xs"
                value={block}
                onChange={(event) => setBlock(Number(event.target.value))}
              >
                {blocks.map((value, index) => (
                  <option key={value.anchor.start} value={index}>
                    {value.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!blocks[block]}
                className="min-h-11 rounded-[4px] border border-border px-3 text-xs font-medium hover:bg-control-muted"
                onClick={() => {
                  const selected = blocks[block];
                  if (selected) beginComment(selected.anchor);
                }}
              >
                Add comment
              </button>
            </div>
            <p className="text-xs text-muted">
              Choose a block with the keyboard, or select text in the artifact.
            </p>
          </div>
        ) : null}
        <div ref={reader} onPointerUp={captureSelection} onKeyUp={captureSelection}>
          {children}
        </div>
      </div>
      {panelState !== "unopened" ? (
        <div hidden={!open} className="min-w-0">
          <ArtifactReviewPanel
            sessionId={sessionId}
            artifactId={artifactId}
            artifactVersion={artifactVersion}
            historical={historical}
            readOnly={readOnly}
            anchor={anchor}
            onClearAnchor={() => setAnchor(null)}
            openerRef={opener}
            onClose={() => {
              setPanelState("hidden");
              opener.current?.focus();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
