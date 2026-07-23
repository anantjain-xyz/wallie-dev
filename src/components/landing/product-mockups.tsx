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

type BoardTone = "accent" | "muted" | "success" | "warning";

type BoardLane = {
  cards: {
    actor: string;
    name: string;
    status: string;
    tone: BoardTone;
  }[];
  name: string;
};

const boardToneClasses: Record<BoardTone, string> = {
  accent: "border-accent/70 bg-accent-soft",
  muted: "border-border/80 bg-canvas",
  success: "border-success/60 bg-success-soft",
  warning: "border-warning/60 bg-warning-soft",
};

const boardStatusClasses: Record<BoardTone, string> = {
  accent: "text-accent",
  muted: "text-muted",
  success: "text-success",
  warning: "text-warning",
};

export function PipelineBoardMockup() {
  const lanes: BoardLane[] = [
    {
      name: "Plan",
      cards: [
        { actor: "Engineer", name: "Task 1", status: "Reviewing plan", tone: "muted" },
        { actor: "Codex", name: "Task 5", status: "Drafting plan", tone: "muted" },
      ],
    },
    {
      name: "Build",
      cards: [
        { actor: "Claude Code", name: "Task 2", status: "Agent working", tone: "accent" },
        { actor: "Codex", name: "Task 6", status: "Agent working", tone: "accent" },
      ],
    },
    {
      name: "Review",
      cards: [
        {
          actor: "Product designer",
          name: "Task 3",
          status: "Ready for approval",
          tone: "warning",
        },
      ],
    },
    {
      name: "Land",
      cards: [{ actor: "Engineer", name: "Task 4", status: "Approved", tone: "success" }],
    },
  ];

  return (
    <figure className="overflow-hidden rounded-[10px] border border-border bg-sheet p-3 shadow-[var(--shadow-elevated)] sm:p-4">
      <figcaption className="sr-only">
        Multiplayer pipeline board with agents working and experts approving tasks
      </figcaption>
      <div aria-hidden="true">
        <div className="mb-4 flex items-center justify-between gap-3 border-b border-border pb-3">
          <p className="text-[13px] font-semibold text-foreground">Pipeline</p>
          <div className="flex items-center">
            {["C", "A", "S", "D"].map((initial, index) => (
              <span
                key={initial}
                className={`flex h-7 w-7 items-center justify-center rounded-full border border-sheet type-annotation font-semibold ${
                  index < 2
                    ? "bg-accent-soft text-accent"
                    : index === 2
                      ? "bg-success-soft text-success"
                      : "bg-warning-soft text-warning"
                } ${index > 0 ? "-ml-1.5" : ""}`}
              >
                {initial}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-0">
          {lanes.map((lane) => (
            <div
              key={lane.name}
              className="min-w-0 border-border/70 sm:border-l sm:px-2.5 sm:first:border-l-0 sm:first:pl-0 sm:last:pr-0 md:px-3"
            >
              <p className="mb-2 text-[13px] font-semibold text-foreground">{lane.name}</p>
              <div className="flex flex-col gap-2">
                {lane.cards.map((card) => (
                  <div
                    key={card.name}
                    className={`rounded-[6px] border px-2.5 py-2.5 ${boardToneClasses[card.tone]}`}
                  >
                    <p className="text-xs font-semibold leading-4 text-foreground">{card.name}</p>
                    <p
                      className={`mt-1 type-annotation font-semibold leading-4 ${boardStatusClasses[card.tone]}`}
                    >
                      {card.status}
                    </p>
                    <p className="mt-1 type-annotation leading-4 text-muted">{card.actor}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

type BrandName = "claude" | "codex" | "cursor" | "daytona" | "e2b" | "linear" | "vercel";

function BrandGlyph({ brand }: { brand: BrandName }) {
  if (brand === "vercel") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
        <path d="M12 3 23 21H1L12 3Z" />
      </svg>
    );
  }

  if (brand === "linear") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" strokeWidth="2" />
        <path d="m5.6 8.2 10.2 10.2M4.2 12l7.8 7.8M8.2 5.6l10.2 10.2" strokeWidth="1.5" />
      </svg>
    );
  }

  if (brand === "cursor") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" aria-hidden="true">
        <path d="m5 4 13.5 8L13 14l-2.5 6L5 4Z" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }

  if (brand === "claude") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
        <path d="M10.8 2h2.4v7.2l5.1-5.1L20 5.8l-5.1 5.1H22v2.4h-7.1l5.1 5.1-1.7 1.7-5.1-5.1V22h-2.4v-7.1l-5.1 5.1L4 18.3l5.1-5.1H2v-2.4h7.1L4 5.7 5.7 4l5.1 5.1V2Z" />
      </svg>
    );
  }

  if (brand === "codex") {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" aria-hidden="true">
        <path
          d="M12 3.2 16 5.5l4.1 2.3v8.4L16 18.5 12 20.8 8 18.5l-4.1-2.3V7.8L8 5.5 12 3.2Z"
          strokeWidth="1.7"
        />
        <circle cx="12" cy="12" r="3.3" strokeWidth="1.7" />
      </svg>
    );
  }

  return (
    <span className="font-mono type-annotation font-bold tracking-[-0.08em]">
      {brand === "daytona" ? "D" : "E2B"}
    </span>
  );
}

function BrandMark({ brand, label, status }: { brand: BrandName; label: string; status?: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-2 rounded-[6px] border border-border bg-canvas px-2.5 py-2.5 min-[480px]:flex-row min-[480px]:items-center">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] bg-sheet text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
        <BrandGlyph brand={brand} />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold leading-4 text-foreground">{label}</span>
        {status ? (
          <span className="mt-0.5 block type-annotation leading-4 text-muted">{status}</span>
        ) : null}
      </span>
    </div>
  );
}

export function StackWorkflowMockup() {
  return (
    <ProductCrop label="Your stack · Your workflow">
      <div aria-hidden="true">
        <div>
          <p className="font-mono type-annotation font-semibold uppercase tracking-[0.12em] text-muted">
            Coding agents
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <BrandMark brand="codex" label="Codex" status="Use subscription" />
            <BrandMark brand="claude" label="Claude Code" status="Available" />
            <BrandMark brand="cursor" label="Cursor" status="Coming soon" />
          </div>
        </div>

        <div className="mt-4">
          <p className="font-mono type-annotation font-semibold uppercase tracking-[0.12em] text-muted">
            Sandboxes
          </p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <BrandMark brand="vercel" label="Vercel" />
            <BrandMark brand="e2b" label="E2B" />
            <BrandMark brand="daytona" label="Daytona" />
          </div>
        </div>

        <div className="mt-4 rounded-[6px] border border-border bg-canvas p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-foreground">Define every handoff</p>
            <span className="rounded-full bg-accent-soft px-2 py-1 type-annotation font-semibold text-accent">
              Your pipeline
            </span>
          </div>
          <div className="mt-3 grid grid-cols-4 gap-1.5">
            {["Plan", "Design", "Build", "Land"].map((stage, index) => (
              <div key={stage} className="relative">
                <div
                  className={`rounded-[5px] border px-1.5 py-2 text-center type-annotation font-semibold ${
                    index === 3
                      ? "border-success/60 bg-success-soft text-success"
                      : "border-border bg-sheet text-foreground"
                  }`}
                >
                  {stage}
                </div>
                {index < 3 ? (
                  <span className="absolute -right-1.5 top-1/2 z-10 -translate-y-1/2 bg-canvas px-0.5 type-annotation text-muted">
                    →
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="rounded-full border border-border bg-sheet px-2 py-1 type-annotation font-medium text-muted">
              Engineer approval
            </span>
            <span className="rounded-full border border-border bg-sheet px-2 py-1 type-annotation font-medium text-muted">
              Designer approval
            </span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 type-annotation font-semibold text-foreground">
            <span className="flex h-6 w-6 items-center justify-center rounded-[5px] bg-success-soft text-success">
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current">
                <path d="m6 12 4 4 8-8" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </span>
            Open source · MIT licensed
          </div>
          <div className="flex items-center gap-1.5 type-annotation text-muted">
            <span className="flex h-5 w-5 items-center justify-center">
              <BrandGlyph brand="linear" />
            </span>
            Linear issue source
          </div>
        </div>
      </div>
    </ProductCrop>
  );
}

const approvalStages = [
  {
    detail: "Approves architecture",
    name: "Plan",
    reviewer: "Engineer",
    tone: "success",
  },
  {
    detail: "Approves experience",
    name: "Design",
    reviewer: "Product designer",
    tone: "warning",
  },
  {
    detail: "Runs verified build",
    name: "Build",
    reviewer: "Coding agent + CI",
    tone: "muted",
  },
] as const;

export function ExpertApprovalMockup() {
  return (
    <ProductCrop label="Session · Approval routing">
      <div aria-hidden="true">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs font-semibold text-accent">TASK 2</p>
            <p className="mt-1 text-[13px] font-semibold text-foreground">
              Improve the workspace setup flow
            </p>
          </div>
          <span className="rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning">
            Expert review
          </span>
        </div>

        <div className="relative mt-5 h-12 overflow-hidden rounded-[6px] border border-border bg-canvas">
          <div className="absolute inset-x-4 top-1/2 h-px -translate-y-1/2 bg-border" />
          <div className="landing-flow-progress absolute inset-x-4 top-1/2 h-0.5 origin-left -translate-y-1/2 bg-accent" />
          <span className="absolute left-4 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-accent" />
          <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-warning" />
          <span className="absolute right-4 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-success" />
          <span className="landing-flow-task absolute top-2.5 z-10 rounded-full border border-accent bg-sheet px-2.5 py-1 font-mono type-annotation font-semibold text-accent shadow-[var(--shadow-elevated)]">
            Task 2
          </span>
        </div>

        <ol className="mt-3 grid grid-cols-3 gap-2">
          {approvalStages.map((stage, index) => (
            <li
              key={stage.name}
              className={`landing-flow-stage-${index + 1} rounded-[6px] border border-border bg-sheet p-2.5`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="type-annotation font-semibold text-foreground">{stage.name}</span>
                <span
                  className={`h-2 w-2 rounded-full ${
                    stage.tone === "success"
                      ? "bg-success"
                      : stage.tone === "warning"
                        ? "bg-warning"
                        : "bg-control-muted"
                  }`}
                />
              </div>
              <p className="mt-2 type-annotation font-semibold leading-4 text-foreground">
                {stage.reviewer}
              </p>
              <p className="mt-0.5 type-annotation leading-4 text-muted">{stage.detail}</p>
            </li>
          ))}
        </ol>

        <div className="mt-4 grid gap-2 min-[420px]:grid-cols-2">
          <div className="landing-flow-event-1 flex items-center gap-2 rounded-[6px] bg-success-soft px-3 py-2 type-annotation font-semibold text-success">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success type-annotation text-sheet">
              ✓
            </span>
            Engineer approved Plan
          </div>
          <div className="landing-flow-event-2 flex items-center gap-2 rounded-[6px] bg-success-soft px-3 py-2 type-annotation font-semibold text-success">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success type-annotation text-sheet">
              ✓
            </span>
            Designer approved UI
          </div>
        </div>
      </div>
    </ProductCrop>
  );
}

const validationChecks = [
  ["Tests", "48 passed"],
  ["Typecheck", "Clean"],
  ["End-to-end", "3 flows"],
  ["Visual proof", "4 views"],
] as const;

function ProofThumbnail({ mobile = false }: { mobile?: boolean }) {
  return (
    <div
      className={`overflow-hidden rounded-[4px] border border-border bg-sheet p-1.5 ${
        mobile ? "mx-auto w-10" : "w-full"
      }`}
    >
      <div className="h-1 rounded-full bg-control-muted" />
      <div className="mt-1.5 grid grid-cols-[0.35fr_0.65fr] gap-1">
        <div className="rounded-[2px] bg-accent-soft" />
        <div className="space-y-1">
          <div className="h-1 rounded-full bg-control-muted" />
          <div className="h-1 w-3/4 rounded-full bg-control-muted" />
          <div className="h-2 rounded-[2px] bg-success-soft" />
        </div>
      </div>
    </div>
  );
}

export function ValidationProofMockup() {
  return (
    <ProductCrop label="Pull request · Review ready">
      <div aria-hidden="true">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
          <div>
            <p className="font-mono text-xs font-semibold text-accent">PR #184</p>
            <p className="mt-1 text-[13px] font-semibold leading-5 text-foreground">
              Complete workspace setup flow
            </p>
            <p className="mt-1 font-mono type-annotation text-muted">wallie/task-2 → main</p>
          </div>
          <span className="shrink-0 rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success">
            Ready to review
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {validationChecks.map(([name, result]) => (
            <div
              key={name}
              className="flex items-center gap-2 rounded-[6px] border border-border bg-canvas px-3 py-2.5"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft type-annotation font-bold text-success">
                ✓
              </span>
              <div className="min-w-0">
                <p className="type-annotation font-semibold leading-4 text-foreground">{name}</p>
                <p className="type-annotation leading-4 text-muted">{result}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 rounded-[6px] border border-border bg-canvas p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-foreground">Evidence attached</p>
            <span className="type-annotation font-medium text-success">All checks passed</span>
          </div>
          <div className="mt-3 grid grid-cols-[1fr_0.36fr] items-stretch gap-2">
            <ProofThumbnail />
            <ProofThumbnail mobile />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 type-annotation text-muted">
          <span className="font-mono">Commit 8f41c2a</span>
          <span>Tests, screenshots, and run notes included</span>
        </div>
      </div>
    </ProductCrop>
  );
}
