import Link from "next/link";

import { StatusChip } from "@/components/shared/status-chip";
import { WallieMark } from "@/components/shared/wallie-mark";
import {
  workspaceIssueDetailPath,
  workspaceIssuesPath,
  workspaceSettingsPath,
} from "@/lib/routes";
import { siteConfig } from "@/lib/site-config";

const sampleSlug = siteConfig.sampleWorkspaceSlug;

const routeCards = [
  {
    href: workspaceIssuesPath(sampleSlug),
    title: "Workspace Issue List",
    summary:
      "Shared shell, issue list placeholder surface, and query-param route contract.",
  },
  {
    href: workspaceIssueDetailPath(sampleSlug, 101),
    title: "Issue Detail",
    summary:
      "Reserved for plan/design fields, comments, links, GitHub PR state, and Wallie runs.",
  },
  {
    href: workspaceSettingsPath(sampleSlug),
    title: "Workspace Settings",
    summary:
      "Scaffold for workspace profile, GitHub, billing, and encrypted secrets management.",
  },
] as const;

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <section className="grid gap-6 lg:grid-cols-[1.35fr_0.95fr]">
        <div className="rounded-[2rem] border border-border/90 bg-surface/95 p-6 shadow-[0_24px_80px_rgba(20,33,61,0.08)] backdrop-blur sm:p-8">
          <div className="flex items-start justify-between gap-5">
            <div className="space-y-4">
              <StatusChip tone="ready">Bootstrap Complete</StatusChip>
              <div className="space-y-3">
                <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
                  Wallie cloud rebuild scaffold
                </h1>
                <p className="max-w-2xl text-sm leading-7 text-muted sm:text-base">
                  This baseline establishes the App Router structure, shared shell,
                  typed route helpers, and validation primitives for the Vercel +
                  Supabase rebuild without porting the dead local-first stack.
                </p>
              </div>
            </div>
            <WallieMark className="hidden sm:flex" />
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href={workspaceIssuesPath(sampleSlug)}
              className="rounded-full bg-foreground px-5 py-3 text-sm font-semibold text-background transition hover:translate-y-[-1px]"
            >
              Open workspace shell
            </Link>
            <Link
              href="/onboarding/workspace"
              className="rounded-full border border-foreground/10 bg-surface-strong px-5 py-3 text-sm font-semibold text-foreground transition hover:border-accent/40 hover:text-accent"
            >
              Review onboarding stub
            </Link>
          </div>
        </div>

        <div className="rounded-[2rem] border border-border/90 bg-foreground p-6 text-background shadow-[0_24px_80px_rgba(20,33,61,0.16)] sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-background/65">
            Reference Contract
          </p>
          <ul className="mt-5 space-y-4 text-sm leading-7 text-background/90">
            {siteConfig.references.map((reference) => (
              <li key={reference}>{reference}</li>
            ))}
          </ul>
          <div className="mt-8 rounded-[1.5rem] border border-white/10 bg-white/6 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.26em] text-background/65">
              Guardrails
            </p>
            <ul className="mt-3 space-y-3 text-sm leading-6 text-background/90">
              {siteConfig.principles.map((principle) => (
                <li key={principle}>{principle}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {routeCards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="rounded-[1.75rem] border border-border/80 bg-surface/90 p-6 shadow-[0_18px_60px_rgba(20,33,61,0.08)] transition hover:-translate-y-1 hover:border-accent/35"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.26em] text-muted">
              Route Stub
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
              {card.title}
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted">{card.summary}</p>
          </Link>
        ))}
      </section>
    </main>
  );
}
