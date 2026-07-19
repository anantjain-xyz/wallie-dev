"use client";

import { useEffect, useState } from "react";

import { MarkdownContent } from "@/components/shared/markdown-content";
import { OverlayProvider } from "@/components/ui/overlay-provider";
import { useOptionalToast } from "@/components/ui/toast";
import {
  ARTIFACT_FIXTURE_EMPTY,
  ARTIFACT_FIXTURE_FAILED,
  ARTIFACT_FIXTURE_FULL_MARKDOWN,
  ARTIFACT_FIXTURE_HOSTILE,
  ARTIFACT_FIXTURE_PLAIN_TEXT,
  ARTIFACT_FIXTURE_RAW_JSON,
} from "@/features/sessions/detail/artifact-fixtures";
import { cn } from "@/lib/utils";

type FixtureView = "rendered" | "raw" | "versions" | "empty" | "failed" | "hostile" | "plain";

const TABS: Array<"rendered" | "raw" | "versions"> = ["rendered", "raw", "versions"];

const VERSION_ROWS = [
  {
    attempt: 3,
    authorLabel: "Claude Code (opus)",
    changesRequested: false,
    createdLabel: "just now",
    latest: true,
    stageSlug: "build",
    version: 3,
  },
  {
    attempt: 2,
    authorLabel: "Codex (gpt-5)",
    changesRequested: true,
    createdLabel: "2 hours ago",
    latest: false,
    stageSlug: "build",
    version: 2,
  },
  {
    attempt: 1,
    authorLabel: "Claude Code (opus)",
    changesRequested: true,
    createdLabel: "yesterday",
    latest: false,
    stageSlug: "build",
    version: 1,
  },
] as const;

export function ArtifactReaderFixture({
  displayMode = "desktop",
  initialTheme = "light",
  initialView = "rendered",
}: {
  displayMode?: "desktop" | "mobile";
  initialTheme?: "light" | "dark";
  initialView?: FixtureView;
}) {
  return (
    <OverlayProvider>
      <ArtifactReaderFixtureInner
        displayMode={displayMode}
        initialTheme={initialTheme}
        initialView={initialView}
      />
    </OverlayProvider>
  );
}

function ArtifactReaderFixtureInner({
  displayMode,
  initialTheme,
  initialView,
}: {
  displayMode: "desktop" | "mobile";
  initialTheme: "light" | "dark";
  initialView: FixtureView;
}) {
  const { pushToast } = useOptionalToast();
  const [theme, setTheme] = useState(initialTheme);
  const [view, setView] = useState<FixtureView>(initialView);
  const activeTab = view === "raw" || view === "versions" ? view : "rendered";
  const selectedVersion = view === "versions" ? 2 : 3;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div
      className={cn(
        "min-h-screen bg-canvas text-foreground",
        displayMode === "mobile" && "w-[320px]",
      )}
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">Artifact reader fixture</p>
          <button
            type="button"
            className="rounded-[4px] border border-border px-2 py-1 text-xs"
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
          >
            Theme: {theme}
          </button>
          {(
            ["rendered", "raw", "versions", "empty", "failed", "hostile", "plain"] as FixtureView[]
          ).map((option) => (
            <button
              key={option}
              type="button"
              className={cn(
                "rounded-[4px] px-2 py-1 text-xs capitalize",
                view === option ? "bg-control-muted font-medium" : "text-muted",
              )}
              onClick={() => setView(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-auto max-w-3xl p-4">
        <section className="ui-sheet">
          <div className="border-b border-border px-4 py-3">
            <h1 className="text-[13px] font-semibold text-foreground">Build artifact</h1>
            <p className="mt-0.5 type-annotation text-muted">
              Review this output before approving.
            </p>
          </div>

          <div className="p-4">
            <h2 className="sr-only" id="artifact-version-heading">
              build artifact · version {selectedVersion}
              {selectedVersion === 3 ? " (latest)" : ""}
            </h2>

            <div aria-label="Artifact views" className="mb-3 flex gap-1" role="tablist">
              {TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  aria-selected={activeTab === tab}
                  className={cn(
                    "rounded-[4px] px-2.5 py-1 text-xs font-medium capitalize",
                    activeTab === tab
                      ? "bg-control-muted text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                  onClick={() => setView(tab)}
                  role="tab"
                >
                  {tab}
                </button>
              ))}
            </div>

            {view === "versions" ? (
              <ul aria-labelledby="artifact-version-heading" className="space-y-2">
                {VERSION_ROWS.map((artifact) => {
                  const isSelected = artifact.version === selectedVersion;
                  return (
                    <li key={artifact.version}>
                      <button
                        type="button"
                        aria-current={isSelected ? "true" : undefined}
                        className={cn(
                          "w-full rounded-[6px] border px-3 py-2.5 text-left",
                          isSelected
                            ? "border-accent/40 bg-accent-soft"
                            : "border-border hover:bg-control-muted/40",
                        )}
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-xs font-semibold text-foreground">
                            Version {artifact.version}
                            {artifact.latest ? " · Latest" : ""}
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
                            <dd>{artifact.createdLabel}</dd>
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

            {view === "empty" ? (
              <p className="rounded-[4px] border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
                No artifact recorded for this stage.
              </p>
            ) : null}

            {view === "failed" ? (
              <div
                className="mb-3 flex items-center justify-between gap-3 rounded-[4px] border border-warning/20 bg-warning-soft px-3 py-2 text-xs text-warning"
                role="alert"
              >
                <span>{ARTIFACT_FIXTURE_FAILED.error}</span>
                <button className="font-semibold underline underline-offset-2" type="button">
                  Retry
                </button>
              </div>
            ) : null}

            {view === "raw" ? (
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="type-annotation uppercase tracking-wide text-muted">
                    v3 · Latest · just now
                  </p>
                  <button
                    type="button"
                    className="rounded-[4px] border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-control-muted"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(ARTIFACT_FIXTURE_FULL_MARKDOWN)
                        .then(() =>
                          pushToast({
                            priority: "polite",
                            title: "Markdown copied.",
                            tone: "success",
                          }),
                        )
                        .catch(() =>
                          pushToast({
                            priority: "assertive",
                            title: "Could not copy Markdown.",
                            tone: "danger",
                          }),
                        );
                    }}
                  >
                    Copy Markdown
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-words rounded-[4px] p-3 text-xs leading-5 text-foreground">
                  {ARTIFACT_FIXTURE_FULL_MARKDOWN}
                </pre>
              </div>
            ) : null}

            {view === "rendered" || view === "hostile" || view === "plain" ? (
              <div>
                <p className="mb-2 type-annotation uppercase tracking-wide text-muted">
                  v3 · Latest · just now
                </p>
                <MarkdownContent>
                  {view === "hostile"
                    ? ARTIFACT_FIXTURE_HOSTILE
                    : view === "plain"
                      ? ARTIFACT_FIXTURE_PLAIN_TEXT
                      : ARTIFACT_FIXTURE_FULL_MARKDOWN}
                </MarkdownContent>
              </div>
            ) : null}

            {view === "failed" ? (
              <pre className="whitespace-pre-wrap break-words rounded-[4px] bg-canvas p-3 text-xs leading-5 text-foreground">
                {JSON.stringify(ARTIFACT_FIXTURE_RAW_JSON, null, 2)}
              </pre>
            ) : null}

            {view === "empty" && ARTIFACT_FIXTURE_EMPTY ? null : null}
          </div>
        </section>
      </div>
    </div>
  );
}
