const steps = [
  { name: "Plan", detail: "Review the approach before code changes." },
  { name: "Build", detail: "Your agent implements and validates the change." },
];

export function StackWorkflowMockup() {
  return (
    <figure className="overflow-hidden rounded-[10px] border border-border/70 bg-sheet shadow-[var(--shadow-elevated)]">
      <figcaption className="flex items-center justify-between gap-3 border-b border-border/50 px-5 py-4">
        <span className="text-[13px] font-semibold text-foreground">From task to pull request</span>
        <span className="rounded-full bg-control-hover px-2 py-1 type-annotation text-muted">
          Example workflow
        </span>
      </figcaption>
      <div className="p-5 sm:p-6">
        <div className="rounded-[6px] border border-border/60 bg-canvas p-4">
          <p className="type-annotation font-medium uppercase tracking-[0.1em] text-muted">
            Your task
          </p>
          <p className="mt-2 text-[16px] font-medium leading-6 text-foreground">
            Add dark mode and remember my preference
          </p>
          <p className="mt-2 text-xs leading-5 text-muted">
            Start with a prompt. Attach a Linear issue if you have one.
          </p>
        </div>
        <ol className="my-5 space-y-5">
          {steps.map((step, index) => (
            <li key={step.name} className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-xs font-semibold text-accent"
              >
                {index + 1}
              </span>
              <div>
                <p className="text-[13px] font-semibold leading-7 text-foreground">{step.name}</p>
                <p className="text-xs leading-5 text-muted">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="rounded-[6px] border border-border/60 bg-control-hover px-4 py-3">
          <p className="text-[13px] font-semibold text-foreground">
            A pull request, ready for review
          </p>
          <p className="mt-1 text-xs leading-5 text-muted">
            Inspect the changes in GitHub and merge when you&apos;re ready.
          </p>
        </div>
        <p className="mt-4 type-annotation leading-5 text-muted">
          Start with Plan → Build. Customize stages and reviewers to fit your team.
        </p>
      </div>
    </figure>
  );
}
