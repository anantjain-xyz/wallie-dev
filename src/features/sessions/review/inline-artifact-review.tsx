"use client";

import dynamic from "next/dynamic";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { cn } from "@/lib/utils";

import {
  artifactPassageRanges,
  artifactPassageRects,
  firstPassageRect,
  indexArtifactText,
  revealArtifactPassage,
} from "./artifact-passage";
import styles from "./inline-artifact-review.module.css";
import {
  reviewReadOnlyMessage,
  type ReviewReadOnlyReason,
  type ReviewSessionReadOnlyReason,
} from "./comment-access";
import { OPEN_REVIEW_COMMENTS_EVENT } from "./open-comments";
import type { PassageThreadRequest } from "./review-panel";
import { selectedArtifactSourceAnchor } from "./selection";
import { type ArtifactSourceAnchor, validateArtifactSourceAnchor } from "./source-anchor";
import type { ArtifactReviewThread, ReviewThreadListPayload } from "./types";

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

type PassageMarker = { top: number; threads: ArtifactReviewThread[] };
type LoadedThreads = Pick<ReviewThreadListPayload, "threads" | "counts">;
type ThreadPassage = { anchor: ArtifactSourceAnchor; threadId: string };

function passageMarkers(reader: HTMLElement, threads: ArtifactReviewThread[]): PassageMarker[] {
  const text = indexArtifactText(reader);
  const top = reader.getBoundingClientRect().top;
  const positions = threads
    .flatMap((thread) => {
      const anchor = thread.anchor;
      if (
        !anchor ||
        typeof anchor !== "object" ||
        Array.isArray(anchor) ||
        typeof anchor.start !== "number" ||
        typeof anchor.end !== "number" ||
        typeof anchor.quote !== "string"
      )
        return [];
      const rect = firstPassageRect(
        artifactPassageRanges(text, { start: anchor.start, end: anchor.end, quote: anchor.quote }),
      );
      return rect ? [{ thread, top: Math.max(0, rect.top - top - 8) }] : [];
    })
    .sort((a, b) => a.top - b.top);
  const markers: PassageMarker[] = [];
  for (const position of positions) {
    const previous = markers.at(-1);
    if (previous && position.top - previous.top < 44) previous.threads.push(position.thread);
    else markers.push({ top: position.top, threads: [position.thread] });
  }
  return markers;
}

export function InlineArtifactReview({
  sessionId,
  artifactId,
  artifactVersion,
  source,
  historical,
  initiallyOpen = false,
  readOnlyReason: sessionReadOnlyReason = null,
  displayMode = "rendered",
  onShowRaw,
  motionRef,
  children,
}: {
  sessionId: string;
  artifactId: string;
  artifactVersion: number;
  source: string;
  historical: boolean;
  initiallyOpen?: boolean;
  readOnlyReason?: ReviewSessionReadOnlyReason | null;
  displayMode?: "rendered" | "raw";
  onShowRaw?: () => void;
  motionRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const [panelState, setPanelState] = useState<"unopened" | "open" | "hidden">(
    initiallyOpen ? "open" : "unopened",
  );
  const open = panelState === "open";
  const permissionNoticeId = useId();
  const [verifiedReadOnlyReason, setVerifiedReadOnlyReason] = useState<ReviewReadOnlyReason | null>(
    "loading",
  );
  const readOnlyReason = sessionReadOnlyReason ?? verifiedReadOnlyReason;
  const readOnly = readOnlyReason !== null;
  const [selection, setSelection] = useState<{
    anchor: ArtifactSourceAnchor;
    top: number;
    left: number;
  } | null>(null);
  const [anchor, setAnchor] = useState<ArtifactSourceAnchor | null>(null);
  const [passage, setPassage] = useState<ThreadPassage | null>(null);
  const [passageStatus, setPassageStatus] = useState<"raw" | "unavailable" | null>(null);
  const [loadedThreads, setLoadedThreads] = useState<LoadedThreads | null>(null);
  const [markers, setMarkers] = useState<PassageMarker[]>([]);
  const [request, setRequest] = useState<PassageThreadRequest | null>(null);
  const [highlight, setHighlight] = useState<{
    target: ArtifactSourceAnchor | ThreadPassage;
    mode: typeof displayMode;
    rects: ReturnType<typeof artifactPassageRects>;
  } | null>(null);
  const [selectionIssue, setSelectionIssue] = useState<string | null>(null);
  const selectionAction = useRef<HTMLButtonElement>(null);
  const reader = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement>(null);
  const lastJump = useRef<ArtifactSourceAnchor | ThreadPassage | null>(null);
  const setReader = useCallback(
    (element: HTMLDivElement | null) => {
      reader.current = element;
      if (motionRef) motionRef.current = element;
    },
    [motionRef],
  );
  const activeTarget = open ? (!readOnly && anchor ? anchor : passage) : null;
  const activeAnchor =
    activeTarget && ("anchor" in activeTarget ? activeTarget.anchor : activeTarget);
  const passageMessage =
    passageStatus === "unavailable"
      ? "The passage is unavailable in this artifact version."
      : passageStatus === "raw"
        ? displayMode === "raw"
          ? "Showing the exact passage in Raw."
          : "Open Raw to see the exact passage."
        : null;
  const selectionStyle: (CSSProperties & Record<`--${string}`, string>) | undefined = selection
    ? { "--selection-top": `${selection.top}px`, "--selection-left": `${selection.left}px` }
    : undefined;
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("reviewThread")) {
      queueMicrotask(() => setPanelState("open"));
    }
    const openComments = () => setPanelState("open");
    window.addEventListener(OPEN_REVIEW_COMMENTS_EVENT, openComments);
    return () => window.removeEventListener(OPEN_REVIEW_COMMENTS_EVENT, openComments);
  }, []);

  const captureSelection = useCallback(() => {
    // Focusing the action may collapse the native selection. Keep the captured
    // source coordinates until activation or focus leaves the action.
    if (document.activeElement === selectionAction.current) return;
    const element = reader.current;
    if (!element || (readOnlyReason !== null && readOnlyReason !== "loading")) return;
    const nativeSelection = window.getSelection();
    const selected = selectedArtifactSourceAnchor(element, source, nativeSelection);
    if (!selected || !nativeSelection) {
      setSelection(null);
      const range = nativeSelection?.rangeCount === 1 ? nativeSelection.getRangeAt(0) : null;
      if (range && !range.collapsed && range.intersectsNode(element)) {
        setSelectionIssue(
          "This selection cannot be commented on. Select up to 10,000 characters with both ends inside the artifact. Try Raw for Markdown syntax or transformed text.",
        );
        setPanelState((current) => (current === "unopened" ? "hidden" : current));
      }
      return;
    }
    setSelectionIssue(null);
    const bounds = element.getBoundingClientRect();
    const rect = firstPassageRect([nativeSelection.getRangeAt(0)]);
    setSelection({
      anchor: selected,
      top: rect ? rect.top - bounds.top : 0,
      left: rect ? rect.left - bounds.left : 0,
    });
    // Selection is also an entry point: load permissions without opening the panel.
    setPanelState((current) => (current === "unopened" ? "hidden" : current));
  }, [readOnlyReason, source]);

  useEffect(() => {
    if (readOnlyReason !== null && readOnlyReason !== "loading") return;
    let frame = 0;
    function selectionChanged() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(captureSelection);
    }
    document.addEventListener("selectionchange", selectionChanged);
    // Permission recovery and mode changes can happen after the browser's last
    // selection event. Revisit the current range when capture becomes available.
    selectionChanged();
    return () => {
      document.removeEventListener("selectionchange", selectionChanged);
      window.cancelAnimationFrame(frame);
    };
  }, [captureSelection, readOnlyReason]);

  const clearPassage = useCallback(() => {
    setPassage(null);
    setPassageStatus(null);
  }, []);

  const showPassage = useCallback(
    (thread: ArtifactReviewThread) => {
      const saved = thread.anchor;
      if (
        thread.artifact_id !== artifactId ||
        thread.artifact_version !== artifactVersion ||
        !validateArtifactSourceAnchor(source, saved)
      ) {
        setPassage(null);
        setPassageStatus("unavailable");
        return;
      }
      const element = reader.current;
      const needsRaw =
        displayMode === "rendered" &&
        element &&
        artifactPassageRanges(indexArtifactText(element), saved).length === 0;
      setPassageStatus(needsRaw ? "raw" : null);
      setPassage({ anchor: saved, threadId: thread.id });
      if (needsRaw) onShowRaw?.();
    },
    [artifactId, artifactVersion, displayMode, onShowRaw, source],
  );

  useLayoutEffect(() => {
    if (open && !returnFocus.current) returnFocus.current = opener.current;
  }, [open]);

  useLayoutEffect(() => {
    const element = reader.current;
    if (!element || !activeAnchor || !activeTarget) {
      lastJump.current = null;
      return;
    }
    const ranges = artifactPassageRanges(indexArtifactText(element), activeAnchor);
    const first = ranges[0];
    if (!first) return;

    if (lastJump.current !== activeTarget) {
      lastJump.current = activeTarget;
      revealArtifactPassage(first, panel.current);
    }

    function measure() {
      if (!element || !activeTarget) return;
      setHighlight({
        target: activeTarget,
        mode: displayMode,
        rects: artifactPassageRects(element, ranges),
      });
    }
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    element.addEventListener("scroll", measure, true);
    return () => {
      observer?.disconnect();
      element.removeEventListener("scroll", measure, true);
    };
  }, [activeAnchor, activeTarget, displayMode]);

  const threads = loadedThreads?.threads;
  useLayoutEffect(() => {
    const element = reader.current;
    if (!element || !threads?.length) return;
    const measure = () => setMarkers(passageMarkers(element, threads));
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [displayMode, threads]);

  function beginComment(value: ArtifactSourceAnchor) {
    if (readOnly) return;
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    setAnchor(value);
    setPanelState("open");
  }

  function closeComments() {
    setPanelState("hidden");
    const target = returnFocus.current;
    (target?.isConnected ? target : opener.current)?.focus({ preventScroll: true });
  }

  return (
    <div
      className={styles.workspace}
      data-comments-open={open}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !event.defaultPrevented) {
          event.stopPropagation();
          closeComments();
        }
      }}
    >
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <button
            ref={opener}
            id="artifact-review-open"
            type="button"
            aria-expanded={open}
            aria-controls="artifact-review-panel"
            className={cn(
              "min-h-11 rounded-[4px] border border-border px-3 text-xs font-medium hover:bg-control-muted",
              open && "border-accent bg-accent-soft text-accent",
            )}
            onClick={(event) => {
              returnFocus.current = event.currentTarget;
              if (open) closeComments();
              else setPanelState("open");
            }}
          >
            Comments
            {loadedThreads ? (
              <span aria-hidden="true" className="ml-1.5 rounded bg-control-muted px-1 text-muted">
                {loadedThreads.counts.open}
              </span>
            ) : null}
          </button>
          {readOnlyReason &&
          (open || selection || selectionIssue || readOnlyReason !== "loading") ? (
            <p id={permissionNoticeId} className="text-xs text-muted">
              {reviewReadOnlyMessage(readOnlyReason)}
            </p>
          ) : null}
        </div>
        {selectionIssue && !readOnly ? (
          <p role="status" className="mb-3 text-xs text-muted">
            {selectionIssue}{" "}
            {displayMode === "rendered" && onShowRaw ? (
              <button type="button" className="min-h-11 text-accent underline" onClick={onShowRaw}>
                Open Raw
              </button>
            ) : null}
          </p>
        ) : null}
        <div
          className={cn(styles.reader, threads?.length && styles.readerWithMarkers)}
          role="region"
          aria-label="Artifact text"
          tabIndex={0}
          ref={setReader}
          onKeyDown={(event) => {
            // Read-only text has no caret by default. Let keyboard users start
            // and extend a native selection from the focused artifact region.
            if (
              event.target !== event.currentTarget ||
              !event.shiftKey ||
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
            )
              return;
            const native = window.getSelection();
            if (!native || typeof native.modify !== "function") return;
            if (!native.anchorNode || !event.currentTarget.contains(native.anchorNode)) {
              const text = event.currentTarget.querySelector(
                "[data-review-text-start], [data-review-rendered-start]",
              )?.firstChild;
              if (!text) return;
              native.collapse(text, 0);
            }
            event.preventDefault();
            native.modify(
              "extend",
              event.key === "ArrowLeft" || event.key === "ArrowUp" ? "backward" : "forward",
              event.ctrlKey || event.metaKey
                ? "word"
                : event.key === "ArrowUp" || event.key === "ArrowDown"
                  ? "line"
                  : "character",
            );
            captureSelection();
          }}
          onPointerUp={captureSelection}
          onKeyUp={captureSelection}
        >
          {children}
          {highlight?.target === activeTarget && highlight.mode === displayMode
            ? highlight.rects.map((rect, index) => (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute bg-accent/25"
                  data-review-passage-highlight=""
                  key={index}
                  style={rect}
                />
              ))
            : null}
          {threads?.length
            ? markers.map(({ top, threads: group }) => {
                const thread = group[0];
                if (!thread) return null;
                const active = open && group.some(({ id }) => id === passage?.threadId);
                const blocking = group.some(
                  ({ status, kind }) => status === "open" && kind === "blocking",
                );
                return (
                  <button
                    aria-label={
                      group.length === 1
                        ? `Open thread by ${thread.author_label}`
                        : `Open ${group.length} threads on this passage`
                    }
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "absolute end-0 flex size-11 items-center justify-center gap-0.5 rounded-[4px] border border-border bg-surface text-xs text-muted hover:bg-control-muted disabled:opacity-50",
                      blocking && "bg-warning-soft text-warning",
                      active && "border-accent bg-accent-soft text-accent",
                    )}
                    disabled={Boolean(anchor && !readOnly)}
                    key={thread.id}
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget;
                      setRequest(
                        group.length === 1
                          ? { kind: "thread", thread }
                          : { kind: "passage", ids: group.map(({ id }) => id) },
                      );
                      setPanelState("open");
                    }}
                    style={{ top }}
                    type="button"
                  >
                    <svg
                      aria-hidden="true"
                      className="size-3.5"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeLinejoin="round"
                    >
                      <path d="M2.5 3.5h11v7h-7l-4 2.5z" />
                    </svg>
                    {group.length}
                  </button>
                );
              })
            : null}
          {(readOnlyReason === null || readOnlyReason === "loading") && selection && !anchor ? (
            <button
              ref={selectionAction}
              aria-label="Comment on selection"
              disabled={readOnly}
              aria-describedby={readOnly ? permissionNoticeId : undefined}
              className={cn(
                "ui-button-primary inline-flex min-h-11 items-center gap-1.5 px-3 text-xs disabled:cursor-not-allowed disabled:opacity-60",
                styles.selectionAction,
              )}
              onClick={() => {
                returnFocus.current = opener.current;
                beginComment(selection.anchor);
              }}
              onPointerDown={(event) => event.preventDefault()}
              onPointerUp={(event) => event.stopPropagation()}
              onKeyUp={(event) => event.stopPropagation()}
              onBlur={captureSelection}
              style={selectionStyle}
              type="button"
            >
              + Add comment
            </button>
          ) : null}
        </div>
      </div>
      {panelState !== "unopened" ? (
        <div hidden={!open} className={cn("min-w-0", styles.panel)} ref={panel}>
          <ArtifactReviewPanel
            sessionId={sessionId}
            artifactId={artifactId}
            artifactVersion={artifactVersion}
            historical={historical}
            readOnlyReason={sessionReadOnlyReason}
            anchor={anchor}
            onClearAnchor={() => setAnchor(null)}
            openerRef={returnFocus}
            onClose={closeComments}
            inline={{
              open,
              scrollRef: panel,
              request,
              onRevealThread: showPassage,
              onClearPassage: clearPassage,
              onThreadsChange: setLoadedThreads,
              onReadOnlyReasonChange: setVerifiedReadOnlyReason,
              passageMessage,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
