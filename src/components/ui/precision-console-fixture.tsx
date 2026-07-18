"use client";

import { useEffect, useState } from "react";

import {
  CommandBar,
  MetadataItem,
  MetadataList,
  PageContainer,
  PageHeader,
  PageSection,
  Sheet,
} from "@/components/ui/page-shell";
import { Status, type StatusValue } from "@/components/ui/status";
import { cn } from "@/lib/utils";

const stages = [
  { count: 3, name: "Plan", status: "approved" },
  { count: 2, name: "Build", status: "running" },
  { count: 1, name: "Land", status: "queued" },
] as const satisfies readonly { count: number; name: string; status: StatusValue }[];

const sessions = [
  { id: "#341", status: "awaiting_review", title: "Establish Precision Console hierarchy" },
  { id: "#339", status: "running", title: "Label filters and form controls" },
  { id: "#337", status: "complete", title: "Stream repository setup health" },
] as const satisfies readonly { id: string; status: StatusValue; title: string }[];

export function PrecisionConsoleFixture({
  displayMode = "desktop",
  initialTheme = "light",
}: {
  displayMode?: "desktop" | "mobile";
  initialTheme?: "dark" | "light";
}) {
  const [theme, setTheme] = useState<"dark" | "light">(initialTheme);
  const isMobileFixture = displayMode === "mobile";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <main
      className={cn("min-h-screen bg-canvas text-foreground", isMobileFixture && "w-[390px]")}
      data-precision-console-fixture
      id="main-content"
    >
      <PageContainer
        className={cn("max-w-[1240px]", isMobileFixture && "max-w-[390px] px-4 sm:px-4 sm:pt-10")}
      >
        <PageHeader
          actions={
            <div aria-label="Fixture theme" className="flex gap-1" role="group">
              {(["light", "dark"] as const).map((value) => (
                <button
                  aria-pressed={theme === value}
                  className={theme === value ? "ui-button-primary" : "ui-button"}
                  key={value}
                  onClick={() => setTheme(value)}
                  type="button"
                >
                  {value === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          }
          description="One canvas, one primary sheet, and overlays only when content floats. Rules and spacing carry the rest of the hierarchy."
          eyebrow="Design system fixture"
          title="Precision Console"
        />

        <CommandBar aria-label="Fixture command bar" className="mb-8">
          <label className="min-w-[14rem] flex-1">
            <span className="sr-only">Search sessions</span>
            <input className="ui-input" placeholder="Search sessions" type="search" />
          </label>
          <button className="ui-button" type="button">
            Active
          </button>
          <button className="ui-button-primary" type="button">
            New session
          </button>
        </CommandBar>

        <div className={cn("grid gap-6", !isMobileFixture && "lg:grid-cols-2")}>
          <FixtureSheet compact={isMobileFixture} eyebrow="Pipeline" title="Review queue">
            <div className="divide-y divide-border">
              {stages.map((stage, index) => (
                <div className="grid grid-cols-[1fr_auto] gap-4 py-4" key={stage.name}>
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono type-annotation text-muted">0{index + 1}</span>
                      <h3 className="text-sm font-semibold">{stage.name}</h3>
                    </div>
                    <p className="mt-1 type-secondary text-muted">
                      {stage.count} session{stage.count === 1 ? "" : "s"} in this stage
                    </p>
                  </div>
                  <Status compact value={stage.status} />
                </div>
              ))}
            </div>
          </FixtureSheet>

          <FixtureSheet compact={isMobileFixture} eyebrow="Sessions" title="Recent work">
            <ul className="divide-y divide-border">
              {sessions.map((session) => (
                <li className="grid grid-cols-[1fr_auto] gap-4 py-4" key={session.id}>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono type-annotation text-muted">{session.id}</span>
                      <p className="truncate text-sm font-medium">{session.title}</p>
                    </div>
                    <p className="mt-1 type-secondary text-muted">Updated 4 minutes ago</p>
                  </div>
                  <Status compact value={session.status} />
                </li>
              ))}
            </ul>
          </FixtureSheet>

          <FixtureSheet compact={isMobileFixture} eyebrow="Settings" title="Repository runtime">
            <MetadataList className={cn(isMobileFixture && "sm:grid-cols-1")}>
              <MetadataItem label="Repository" value="wallie-dev" />
              <MetadataItem label="Provider" value="GitHub" />
              <MetadataItem label="Default branch" monospace value="main" />
              <MetadataItem label="Language" value="TypeScript" />
              <MetadataItem label="Model" monospace value="gpt-5-codex" />
              <MetadataItem label="Run policy" value="Approval required" />
            </MetadataList>
          </FixtureSheet>

          <FixtureSheet compact={isMobileFixture} eyebrow="Session detail" title="Build artifact">
            <PageSection
              statusBadge={<Status value="awaiting_review" />}
              tagline="Version 2 · generated 4 minutes ago"
              title="Implementation"
            >
              <div className="space-y-3 text-sm leading-6">
                <p>
                  Shared primitives define the page structure while metadata stays readable as
                  aligned text.
                </p>
                <div className="border-l-2 border-accent pl-3 text-muted">
                  Review the artifact before advancing to Land.
                </div>
              </div>
            </PageSection>
            <aside className="mt-6 rounded-[10px] border border-border bg-overlay p-4 [box-shadow:var(--shadow-elevated)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold">Overlay example</p>
                  <p className="mt-1 type-secondary text-muted">
                    Ten-pixel radius and shadow are reserved for floating content.
                  </p>
                </div>
                <button
                  aria-label="Close overlay example"
                  className="ui-icon-button border-0 bg-transparent"
                  type="button"
                >
                  ×
                </button>
              </div>
            </aside>
          </FixtureSheet>
        </div>
      </PageContainer>
    </main>
  );
}

function FixtureSheet({
  children,
  compact,
  eyebrow,
  title,
}: {
  children: React.ReactNode;
  compact: boolean;
  eyebrow: string;
  title: string;
}) {
  return (
    <Sheet className={compact ? "p-5 sm:p-5" : "p-5 sm:p-6"}>
      <header className="mb-4 border-b border-border pb-4">
        <p className="type-label uppercase tracking-[0.08em] text-muted">{eyebrow}</p>
        <h2 className={cn("mt-1", "type-section-title")}>{title}</h2>
      </header>
      {children}
    </Sheet>
  );
}
