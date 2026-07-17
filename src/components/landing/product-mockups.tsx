import type { ReactNode } from "react";
import Image from "next/image";

type StageCard = {
  count: number;
  description: string;
  items: Array<{
    status: "approved" | "drafting" | "review" | "rejected";
    title: string;
  }>;
  name: string;
};

const stageCards: StageCard[] = [
  {
    count: 3,
    description: "Spec, acceptance criteria, and technical approach.",
    name: "Plan",
    items: [
      { status: "review", title: "Usage limits for sandbox minutes" },
      { status: "drafting", title: "Live artifact version history" },
      { status: "approved", title: "Repository import for monorepos" },
    ],
  },
  {
    count: 4,
    description: "Implementation runs inside connected sandboxes.",
    name: "Build",
    items: [
      { status: "drafting", title: "SAML SSO for enterprise workspaces" },
      { status: "review", title: "Session activity timeline" },
      { status: "rejected", title: "GitHub app permission fallback" },
      { status: "approved", title: "Mobile onboarding flow" },
    ],
  },
  {
    count: 3,
    description: "Merge once CI is green, then capture the rollout.",
    name: "Land",
    items: [
      { status: "review", title: "Enterprise audit log export" },
      { status: "approved", title: "Slack alerts for blocked runs" },
      { status: "approved", title: "Linear duplicate issue handling" },
    ],
  },
];

const runLog = [
  { label: "sandbox", value: "vercel://acme-sso-4921" },
  { label: "agent", value: "codex / gpt-5-codex" },
  { label: "session branch", value: "wallie/saml-sso-google" },
  { label: "artifact", value: "build-output.v3.json" },
];

const onboardingStageRows = [
  {
    approvers: "Ava Patel, Jordan Kim",
    description:
      "Frame the problem and lock the plan: spec, acceptance criteria, technical approach, and reproduction signal.",
    name: "Plan",
    prompt: "Produce a reviewable plan only. Do not modify files.",
    slug: "plan",
  },
  {
    approvers: "Owners and admins (default)",
    description:
      "Implement the approved plan, validate, open a PR, sweep feedback, and verify for sign-off.",
    name: "Build",
    prompt: "Implement: {{session.title}}",
    slug: "build",
  },
  {
    approvers: "Release captain",
    description: "Merge the approved change once CI is green, and capture the rollout.",
    name: "Land",
    prompt: "Land the approved change for {{session.title}}.",
    slug: "land",
  },
];

const onboardingStepTitles = [
  "GitHub",
  "Analyze",
  "Pipeline",
  "Linear",
  "Agent",
  "Verify",
] as const;

type HealthTone = "neutral" | "success" | "warning";

type HealthRow = {
  detail: string;
  label: string;
  tone: HealthTone;
};

type StatusRow = HealthRow & {
  value: string;
};

const pipelineSetupHealthRows: HealthRow[] = [
  {
    detail: "Connected",
    label: "GitHub",
    tone: "success",
  },
  {
    detail: "3 stages",
    label: "Pipeline",
    tone: "success",
  },
  {
    detail: "Optional",
    label: "Linear",
    tone: "neutral",
  },
  {
    detail: "Ready",
    label: "Runtime",
    tone: "success",
  },
];

const runtimeSetupHealthRows: HealthRow[] = [
  {
    detail: "Connected",
    label: "GitHub",
    tone: "success",
  },
  {
    detail: "Ready",
    label: "Repository",
    tone: "success",
  },
  {
    detail: "Connected",
    label: "Vercel Sandbox",
    tone: "success",
  },
  {
    detail: "Ready",
    label: "Runtime",
    tone: "success",
  },
];

const agentConfigRows = [
  { detail: "Provider", label: "Agent provider", value: "Codex" },
  { detail: "Model", label: "Agent model", value: "gpt-5.5" },
  { detail: "Parallel jobs per workspace", label: "Concurrency limit", value: "1" },
  { detail: "Stalled run timeout", label: "Stall timeout (minutes)", value: "15" },
];

const providerAccessRows: StatusRow[] = [
  {
    detail: "Current user has a connected Codex credential.",
    label: "Codex credential",
    tone: "success",
    value: "Connected",
  },
  {
    detail: "wallie-sandboxes",
    label: "Vercel Sandbox",
    tone: "success",
    value: "Ready",
  },
];

const repositoryVariableRows = [
  { key: "DATABASE_URL", status: "Stored" },
  { key: "STRIPE_SECRET_KEY", status: "Stored" },
  { key: "NEXT_PUBLIC_APP_URL", status: "Not set" },
];

const runtimeRequirementRows: StatusRow[] = [
  {
    detail: "Agent configuration values are valid.",
    label: "Agent config",
    tone: "success",
    value: "Ready",
  },
  {
    detail: "Current user has a connected Codex credential.",
    label: "Codex credential",
    tone: "success",
    value: "Ready",
  },
];

function statusClasses(status: StageCard["items"][number]["status"]) {
  if (status === "approved") return "bg-success-soft text-success";
  if (status === "rejected") return "bg-danger-soft text-danger";
  if (status === "drafting") return "bg-accent-soft text-accent";
  return "bg-warning-soft text-warning";
}

function statusLabel(status: StageCard["items"][number]["status"]) {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rerun";
  if (status === "drafting") return "Drafting";
  return "Review";
}

function BrowserFrame({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="overflow-hidden rounded-[16px] border border-border bg-surface shadow-[0_24px_80px_rgba(29,31,34,0.12)]">
      <div className="flex h-10 items-center justify-between border-b border-border bg-surface-strong px-4">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-warning/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
        </div>
        <p className="text-[11px] font-medium text-muted">{title}</p>
        <div className="h-2.5 w-[46px]" aria-hidden="true" />
      </div>
      {children}
    </div>
  );
}

function toneDotClassName(tone: HealthTone) {
  if (tone === "success") return "bg-success";
  if (tone === "warning") return "bg-warning";
  return "bg-muted/60";
}

function toneBadgeClassName(tone: HealthTone) {
  if (tone === "success") return "bg-success-soft text-success";
  if (tone === "warning") return "bg-warning-soft text-warning";
  return "bg-surface-muted text-muted";
}

function OnboardingRail({ activeTitle }: { activeTitle: (typeof onboardingStepTitles)[number] }) {
  const activeIndex = onboardingStepTitles.indexOf(activeTitle);

  return (
    <div className="border-r border-border pr-4 max-md:hidden">
      <p className="mb-4 text-[11px] font-semibold uppercase text-muted">Setup</p>
      <ol className="space-y-1">
        {onboardingStepTitles.map((title, index) => {
          const state =
            index < activeIndex ? "completed" : index === activeIndex ? "active" : "available";
          return (
            <li
              key={title}
              className={`flex items-center gap-2 rounded-[6px] px-3 py-2 text-[12px] font-medium ${
                state === "active"
                  ? "bg-accent-soft text-accent"
                  : state === "completed"
                    ? "text-foreground"
                    : "text-muted"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  state === "active"
                    ? "bg-accent"
                    : state === "completed"
                      ? "bg-success"
                      : "bg-muted/60"
                }`}
                aria-hidden="true"
              />
              {title}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SetupHealthSidebar({ rows }: { rows: HealthRow[] }) {
  return (
    <div className="border-l border-border pl-4 max-md:hidden">
      <p className="mb-4 text-[11px] font-semibold uppercase text-muted">Setup health</p>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.label} className="rounded-[8px] border border-border bg-surface p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[12px] font-medium text-foreground">{row.label}</p>
              <span
                className={`h-2 w-2 rounded-full ${toneDotClassName(row.tone)}`}
                aria-hidden="true"
              />
            </div>
            <p className="mt-1 text-[11px] text-muted">{row.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HeroWorkspaceMockup() {
  return (
    <BrowserFrame title="wallie.dev/w/acme">
      <div className="grid min-h-[520px] grid-cols-[190px_minmax(0,1fr)] bg-surface text-left max-md:min-h-0 max-md:grid-cols-1">
        <div className="border-r border-border bg-surface-strong p-4 max-md:hidden">
          <div className="mb-7 flex items-center gap-2">
            <Image
              src="/wallie-logo-minimal.png"
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 rounded-[8px] object-contain dark:invert"
            />
            <div>
              <p className="text-[13px] font-semibold text-foreground">Wallie</p>
              <p className="text-[11px] text-muted">Acme Corp</p>
            </div>
          </div>
          <nav className="space-y-1 text-[12px] font-medium">
            {["Pipeline", "Sessions", "Settings"].map((item, index) => (
              <div
                key={item}
                className={`rounded-[6px] px-3 py-2 ${
                  index === 0
                    ? "bg-surface text-foreground shadow-[0_1px_1px_rgba(0,0,0,0.04)]"
                    : "text-muted"
                }`}
              >
                {item}
              </div>
            ))}
          </nav>
        </div>

        <div className="min-w-0">
          <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <p className="text-[12px] text-muted">Default pipeline</p>
              <h2 className="text-[20px] font-semibold text-foreground">Sessions</h2>
            </div>
            <div className="rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-muted">
              Realtime sync active
            </div>
          </header>

          <div className="overflow-hidden p-4">
            <div className="grid min-w-[620px] grid-cols-3 gap-3 max-md:min-w-0 max-md:grid-cols-1">
              {stageCards.map((stage) => (
                <section
                  key={stage.name}
                  className="min-h-[380px] border-l border-border pl-3 first:border-l-0 first:pl-0 max-md:min-h-0"
                >
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-[13px] font-semibold text-foreground">{stage.name}</h3>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted">
                        {stage.description}
                      </p>
                    </div>
                    <span className="font-mono text-[11px] text-muted">{stage.count}</span>
                  </div>
                  <div className="space-y-2">
                    {stage.items.map((item) => (
                      <article
                        key={item.title}
                        className="rounded-[8px] border border-border bg-surface p-3 shadow-[0_1px_2px_rgba(0,0,0,0.035)]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-[12px] font-medium leading-5 text-foreground">
                            {item.title}
                          </p>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClasses(item.status)}`}
                          >
                            {statusLabel(item.status)}
                          </span>
                        </div>
                        <div className="mt-3 h-1.5 rounded-full bg-surface-muted">
                          <div className="h-full w-2/3 rounded-full bg-accent/70" />
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

export function SandboxExecutionMockup() {
  return (
    <BrowserFrame title="wallie.dev/w/acme/sessions/42">
      <div className="grid min-h-[430px] grid-cols-[1fr_320px] bg-surface max-md:grid-cols-1">
        <div className="border-r border-border p-5 max-md:border-b max-md:border-r-0">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[12px] text-muted">Build stage</p>
              <h3 className="text-[18px] font-semibold text-foreground">
                SAML SSO for enterprise workspaces
              </h3>
            </div>
            <span className="rounded-full bg-accent-soft px-3 py-1 text-[12px] font-medium text-accent">
              Running in sandbox
            </span>
          </div>

          <div className="space-y-3 rounded-[10px] border border-border bg-[#111827] p-4 font-mono text-[12px] leading-5 text-[#dbeafe]">
            <p>$ pnpm install</p>
            <p className="text-success">resolved 742 packages in isolated workspace</p>
            <p>$ pnpm test -- realtime</p>
            <p className="text-success">12 tests passed</p>
            <p>$ git diff -- src/features/auth/saml.ts</p>
            <p className="text-[#93c5fd]">artifact written: build-output.v3.json</p>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {runLog.map((item) => (
              <div
                key={item.label}
                className="rounded-[8px] border border-border bg-surface-strong p-3"
              >
                <p className="text-[10px] font-semibold uppercase text-muted">{item.label}</p>
                <p className="mt-1 truncate font-mono text-[12px] text-foreground">{item.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-surface-strong p-5">
          <p className="text-[12px] font-semibold text-foreground">Team activity</p>
          <div className="mt-4 space-y-4">
            {[
              ["Wallie", "Started a Vercel Sandbox for Build."],
              ["Maya", "Approved Plan v2."],
              ["Codex", "Opened PR #184 for the session branch."],
              ["Jordan", "Reviewing the latest artifact."],
            ].map(([actor, text]) => (
              <div key={text} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-[10px] font-semibold text-muted">
                  {actor.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <p className="text-[12px] font-medium text-foreground">{actor}</p>
                  <p className="text-[12px] leading-5 text-muted">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}

export function ApprovalGatesMockup() {
  return (
    <BrowserFrame title="wallie.dev/w/acme/onboarding?step=pipeline">
      <div className="grid min-h-[500px] grid-cols-[150px_minmax(0,1fr)_210px] bg-surface p-5 text-left max-md:grid-cols-1">
        <OnboardingRail activeTitle="Pipeline" />

        <div className="min-w-0 px-5 max-md:px-0">
          <div className="mb-5">
            <h3 className="text-[18px] font-semibold text-foreground">Review pipeline</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Review the default phase pipeline before sessions start.
            </p>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="block min-w-[190px] flex-1 space-y-1.5">
                <span className="text-[12px] font-medium text-foreground">Pipeline name</span>
                <div className="ui-input h-9 px-3 py-2 text-[12px]">Default</div>
              </label>
              <div className="rounded-[6px] border border-border bg-surface-strong px-3 py-2 text-[12px] text-foreground">
                Template variables
              </div>
            </div>

            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-foreground">Operating rules</span>
              <div className="ui-textarea min-h-[76px] overflow-hidden font-mono text-[11px] leading-5 text-muted">
                Stay in scope. Sync before coding. Validate every acceptance criterion and report
                honestly.
              </div>
            </label>

            <ol className="space-y-3">
              {onboardingStageRows.map((stage, index) => (
                <li
                  key={stage.slug}
                  className="relative rounded-[10px] border border-border bg-surface p-4"
                >
                  <div className="absolute left-3 top-5 flex h-6 w-6 items-center justify-center rounded-full bg-surface-muted text-[11px] font-semibold text-muted">
                    {index + 1}
                  </div>
                  <div className="space-y-3 pl-9">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 gap-2">
                        <div className="ui-input h-9 min-w-0 flex-1 px-3 py-2 text-[12px] font-medium">
                          {stage.name}
                        </div>
                        <div className="ui-input h-9 w-[96px] px-3 py-2 font-mono text-[11px]">
                          {stage.slug}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1 text-[12px] text-muted">
                        <span className="ui-icon-button h-8 w-8">↑</span>
                        <span className="ui-icon-button h-8 w-8">↓</span>
                      </div>
                    </div>

                    <div className="ui-input h-9 truncate px-3 py-2 text-[12px] text-muted">
                      {stage.description}
                    </div>

                    <div>
                      <p className="mb-1.5 text-[12px] font-medium text-foreground">
                        Prompt template
                      </p>
                      <div className="ui-textarea min-h-[58px] overflow-hidden font-mono text-[11px] leading-5 text-muted">
                        {stage.prompt}
                      </div>
                    </div>

                    <p className="text-[11px] text-muted">Approvers: {stage.approvers} ▸</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <button className="ui-button pointer-events-none h-8 text-[12px]" type="button">
                + Add stage
              </button>
              <button
                className="ui-button-primary pointer-events-none h-8 text-[12px]"
                type="button"
              >
                Save pipeline
              </button>
            </div>
          </div>
        </div>

        <SetupHealthSidebar rows={pipelineSetupHealthRows} />
      </div>
    </BrowserFrame>
  );
}

export function RuntimeChoiceMockup() {
  return (
    <BrowserFrame title="wallie.dev/w/acme/onboarding?step=runtime">
      <div className="grid min-h-[500px] grid-cols-[150px_minmax(0,1fr)_210px] bg-surface p-5 text-left max-md:grid-cols-1">
        <OnboardingRail activeTitle="Agent" />

        <div className="min-w-0 px-5 max-md:px-0">
          <div className="mb-5">
            <h3 className="text-[18px] font-semibold text-foreground">Connect Agent</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Check coding-agent and sandbox runtime readiness.
            </p>
          </div>

          <div className="space-y-4">
            <section className="rounded-[6px] border border-border bg-surface p-4">
              <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h4 className="text-[14px] font-semibold text-foreground">Agent config</h4>
                  <p className="mt-1 text-[12px] leading-5 text-muted">
                    Unset fields use Wallie&apos;s recommended defaults until saved.
                  </p>
                </div>
                <button className="ui-button pointer-events-none h-8 text-[12px]" type="button">
                  Apply recommended defaults
                </button>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {agentConfigRows.map((row) => (
                  <div key={row.label} className="space-y-1.5">
                    <p className="text-[12px] font-medium text-muted">{row.label}</p>
                    <div className="ui-input h-9 truncate px-3 py-2 font-mono text-[12px]">
                      {row.value}
                    </div>
                    <p className="text-[11px] leading-4 text-muted">{row.detail}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <p className="text-[12px] leading-5 text-muted">No unsaved changes.</p>
                <button
                  className="ui-button-primary pointer-events-none h-8 text-[12px]"
                  type="button"
                >
                  Save config
                </button>
              </div>

              <div className="mt-4 border-t border-border pt-4">
                <div className="mb-3 min-w-0">
                  <h4 className="text-[14px] font-semibold text-foreground">Provider access</h4>
                  <p className="mt-1 text-[12px] leading-5 text-muted">
                    Sessions run with the Codex credential saved by the session creator.
                  </p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {providerAccessRows.map((row) => (
                    <div
                      key={row.label}
                      className="rounded-[8px] border border-border bg-surface p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[12px] font-medium text-foreground">{row.label}</p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${toneBadgeClassName(row.tone)}`}
                        >
                          {row.value}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-muted">{row.detail}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="rounded-[6px] border border-border bg-surface">
              <div className="border-b border-border px-4 py-3">
                <h4 className="text-[14px] font-semibold text-foreground">
                  Repository environment variables
                </h4>
                <p className="mt-1 text-[12px] leading-5 text-muted">
                  Detected keys and saved workspace secrets are editable from this list.
                </p>
              </div>
              <div className="divide-y divide-border">
                {repositoryVariableRows.map((row) => (
                  <div
                    key={row.key}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <code className="font-mono text-[12px] font-medium text-foreground">
                      {row.key}
                    </code>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        row.status === "Stored"
                          ? "bg-success-soft text-success"
                          : "bg-surface-muted text-muted"
                      }`}
                    >
                      {row.status}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4">
                <button className="ui-button pointer-events-none h-8 text-[12px]" type="button">
                  + Add variable
                </button>
                <button
                  className="ui-button-primary pointer-events-none h-8 text-[12px]"
                  type="button"
                >
                  Save config
                </button>
              </div>
            </section>

            <section className="rounded-[6px] border border-border bg-surface p-4">
              <h4 className="text-[14px] font-semibold text-foreground">Runtime readiness</h4>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                Provider-specific requirements must pass before this step can complete.
              </p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {runtimeRequirementRows.map((row) => (
                  <div
                    key={row.label}
                    className="rounded-[8px] border border-border bg-surface p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-[12px] font-medium text-foreground">{row.label}</p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${toneBadgeClassName(row.tone)}`}
                      >
                        {row.value}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-muted">{row.detail}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>

        <SetupHealthSidebar rows={runtimeSetupHealthRows} />
      </div>
    </BrowserFrame>
  );
}
