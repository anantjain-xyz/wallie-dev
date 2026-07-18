import type { ReactNode } from "react";

function ProductCrop({ children, label }: { children: ReactNode; label: string }) {
  return (
    <figure className="overflow-hidden rounded-[10px] border border-border bg-sheet shadow-[var(--shadow-elevated)]">
      <figcaption className="border-b border-border bg-control-hover px-4 py-3 font-mono text-xs font-medium text-muted">
        {label}
      </figcaption>
      <div className="p-4 sm:p-5">{children}</div>
    </figure>
  );
}

export function IssueInputMockup() {
  return (
    <ProductCrop label="New session · Source">
      <div aria-hidden="true">
        <p className="text-[13px] font-semibold text-foreground">Linear issue URL</p>
        <div className="mt-2 overflow-hidden rounded-[6px] border border-border bg-canvas px-3 py-3 font-mono text-xs leading-5 text-foreground">
          <span className="block truncate">linear.app/wallie/issue/OP-349</span>
        </div>
        <div className="mt-4 rounded-[6px] border border-border bg-sheet p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-xs font-semibold text-accent">OP-349</span>
            <span className="rounded-full bg-control-muted px-2.5 py-1 text-xs font-medium text-muted">
              Todo
            </span>
          </div>
          <p className="mt-3 text-[13px] font-semibold leading-5 text-foreground">
            Replace the overlong landing page with a focused mobile-first product narrative
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <span className="rounded-[6px] bg-accent px-4 py-2.5 text-[13px] font-semibold text-accent-foreground">
            Create session
          </span>
        </div>
      </div>
    </ProductCrop>
  );
}

export function PipelineProgressMockup() {
  const stages = [
    { detail: "Approved", name: "Plan", tone: "success" },
    { detail: "Artifact v2 ready", name: "Build", tone: "accent" },
    { detail: "Waiting", name: "Land", tone: "muted" },
  ] as const;

  return (
    <ProductCrop label="Session · Pipeline">
      <div aria-hidden="true">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs font-semibold text-accent">OP-349</p>
            <p className="mt-1 text-[13px] font-semibold text-foreground">Landing page narrative</p>
          </div>
          <span className="rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning">
            Review
          </span>
        </div>

        <ol className="mt-5 grid gap-3">
          {stages.map((stage, index) => (
            <li
              key={stage.name}
              className={`grid grid-cols-[30px_minmax(0,1fr)] gap-3 rounded-[6px] border p-3.5 ${
                index === 1 ? "border-accent bg-accent-soft" : "border-border bg-sheet"
              }`}
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full font-mono text-xs font-semibold ${
                  stage.tone === "success"
                    ? "bg-success-soft text-success"
                    : stage.tone === "accent"
                      ? "bg-accent text-accent-foreground"
                      : "bg-control-muted text-muted"
                }`}
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-foreground">{stage.name}</p>
                <p className="mt-0.5 truncate text-xs text-muted">{stage.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </ProductCrop>
  );
}

export function ArtifactDecisionMockup() {
  return (
    <ProductCrop label="Build · Artifact v2">
      <div aria-hidden="true">
        <div className="rounded-[6px] border border-border bg-canvas p-4">
          <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
            <div>
              <p className="font-mono text-xs font-semibold text-accent">landing-page.md</p>
              <p className="mt-1 text-xs text-muted">Build artifact · version 2</p>
            </div>
            <span className="rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning">
              Awaiting review
            </span>
          </div>
          <div className="mt-4 space-y-3">
            <div>
              <p className="font-mono text-xs font-semibold text-foreground">## Validation</p>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                Landing tests, accessibility checks, and responsive views are complete.
              </p>
            </div>
            <div>
              <p className="font-mono text-xs font-semibold text-foreground">## Review note</p>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                Confirm the mobile narrative before advancing to Land.
              </p>
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <span className="rounded-[6px] border border-border bg-sheet px-3 py-2.5 text-center text-[13px] font-semibold text-foreground">
            Return with feedback
          </span>
          <span className="rounded-[6px] bg-accent px-3 py-2.5 text-center text-[13px] font-semibold text-accent-foreground">
            Approve artifact
          </span>
        </div>
      </div>
    </ProductCrop>
  );
}
