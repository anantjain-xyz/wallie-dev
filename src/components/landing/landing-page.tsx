import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";

import { EmailMagicLinkForm } from "@/components/auth/email-magic-link-form";
import {
  ApprovalGatesMockup,
  HeroWorkspaceMockup,
  RuntimeChoiceMockup,
  SandboxExecutionMockup,
} from "@/components/landing/product-mockups";
import { GitHubIcon } from "@/components/shared/icons";

type FeatureSectionProps = {
  body: string;
  children: ReactNode;
  id: string;
  index: string;
  layout?: "split" | "stacked";
  title: string;
};

const nextPath = "/";
const githubUrl = "https://github.com/anantjain-xyz/wallie-dev";
const docsUrl = "https://github.com/anantjain-xyz/wallie-dev#readme";
const selfHostingUrl = "https://github.com/anantjain-xyz/wallie-dev/blob/main/docs/SELF_HOSTING.md";
const licenseUrl = "https://github.com/anantjain-xyz/wallie-dev/blob/main/LICENSE";
const authorUrl = "https://anantjain.xyz";

const heroBadges = ["Open source", "MIT licensed", "Self-hostable"];

export function LandingPage() {
  return (
    <main id="main-content" className="min-h-[100svh] bg-sheet text-foreground tracking-normal">
      <LandingHeader />

      <section className="mx-auto flex w-full max-w-[1180px] flex-col px-5 pb-16 pt-12 sm:px-8 sm:pb-20 sm:pt-16 lg:px-10">
        <div className="mx-auto max-w-[860px] text-center">
          <h1 className="text-[48px] font-normal leading-[0.96] text-foreground sm:text-[72px] lg:text-[88px]">
            Bring agents together with your team in one shared workspace.
          </h1>
          <p className="mx-auto mt-6 max-w-[720px] text-[17px] leading-8 text-muted sm:text-[18px]">
            Wallie turns your plan, build, and land stages into gated, sandboxed runs your team can
            inspect and approve together.
          </p>

          <ul className="mx-auto mt-8 flex flex-wrap items-center justify-center text-[13px] font-medium text-muted">
            {heroBadges.map((badge) => (
              <li key={badge} className="border-l border-border px-3 first:border-l-0">
                {badge}
              </li>
            ))}
          </ul>

          <p className="mx-auto mt-4 max-w-[640px] text-[14px] leading-7 text-muted">
            Works with Linear, GitHub, and Codex or Claude Code.{" "}
            <a
              href={selfHostingUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline focus-visible:outline-none focus-visible:text-accent"
            >
              Self-host it
            </a>{" "}
            or use the free hosted instance.
          </p>
        </div>

        <div className="mt-12 sm:mt-16">
          <HeroWorkspaceMockup />
        </div>
      </section>

      <div className="border-t border-border bg-canvas">
        <FeatureSection
          id="sandboxed-execution"
          index="01"
          title="Sandboxed execution for every stage"
          body="Agent runs execute in a connected sandbox and write logs, messages, and stage artifacts back to the session, so teammates can inspect the same output before approving the next stage."
        >
          <SandboxExecutionMockup />
        </FeatureSection>

        <FeatureSection
          id="approval-gates"
          index="02"
          layout="stacked"
          title="Approval gates your team controls"
          body="Tune every stage to your workflow: reorder gates, assign approvers, customize prompts, inject your own skills, and send Wallie back through a rerun when the artifact needs another pass."
        >
          <ApprovalGatesMockup />
        </FeatureSection>

        <FeatureSection
          id="agent-runtime"
          index="03"
          layout="stacked"
          title="Bring your favorite agent and sandbox"
          body="Use Codex, Claude Code, or the agent setup your team already trusts. Wallie keeps credentials, sandbox readiness, and capability checks visible before work starts."
        >
          <RuntimeChoiceMockup />
        </FeatureSection>
      </div>

      <LandingFooter />
    </main>
  );
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-sheet/95 backdrop-blur supports-[backdrop-filter]:bg-sheet/80">
      <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-3 px-5 py-4 sm:px-8 lg:px-10">
        <Link href="/" className="flex shrink-0 items-center gap-3 focus-visible:outline-none">
          <Image
            src="/wallie-logo-minimal.png"
            alt=""
            width={44}
            height={44}
            className="h-11 w-11 rounded-[6px] object-contain dark:invert"
            priority
          />
          <span className="text-[16px] font-semibold text-foreground">Wallie</span>
        </Link>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ui-touch-target inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-[6px] border border-border bg-sheet px-3 text-[13px] font-medium text-foreground transition-colors hover:border-border-strong hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            <GitHubIcon className="h-4 w-4" />
            <span>GitHub</span>
          </a>

          {/* Desktop keeps the inline email capture; narrower widths fall back to
              a single Get started button so the header always stays on one row. */}
          <div className="hidden lg:block lg:w-[420px]">
            <EmailMagicLinkForm
              next={nextPath}
              variant="inline"
              className="flex items-center gap-2"
              inputClassName="h-9 w-full rounded-[6px] border border-border bg-sheet px-3 text-[13px] text-foreground outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted focus-visible:border-accent/50 focus-visible:shadow-[0_0_0_4px_var(--focus-ring-soft)]"
              submitClassName="inline-flex h-9 shrink-0 items-center justify-center rounded-[6px] border border-accent bg-accent px-4 text-[13px] font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              submitLabel="Get started"
            />
          </div>

          <Link
            href="/login"
            className="ui-touch-target inline-flex h-9 shrink-0 items-center justify-center rounded-[6px] border border-accent bg-accent px-4 text-[13px] font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas lg:hidden"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-border bg-sheet">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
        <div className="flex items-center gap-3">
          <Image
            src="/wallie-logo-minimal.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 rounded-[6px] object-contain dark:invert"
          />
          <span className="text-[14px] font-semibold text-foreground">Wallie</span>
        </div>

        <div className="flex flex-col gap-2 text-[14px] text-muted sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:gap-x-6 sm:gap-y-2">
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
          >
            Docs
          </a>
          <a
            href={selfHostingUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
          >
            Self-hosting guide
          </a>
          <a
            href={licenseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
          >
            MIT License
          </a>
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-2 text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
          >
            <GitHubIcon className="h-4 w-4" />
            <span>GitHub</span>
          </a>
          <span>
            Built by{" "}
            <a
              href={authorUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-foreground underline-offset-4 transition-colors hover:text-accent hover:underline focus-visible:outline-none focus-visible:text-accent"
            >
              Anant Jain
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}

function FeatureSection({
  body,
  children,
  id,
  index,
  layout = "split",
  title,
}: FeatureSectionProps) {
  const contentClassName =
    layout === "stacked"
      ? "mx-auto grid w-full max-w-[1180px] gap-8 px-5 py-16 sm:px-8 sm:py-20 lg:px-10"
      : "mx-auto grid w-full max-w-[1180px] gap-8 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[0.72fr_1.28fr] lg:items-center lg:gap-12 lg:px-10";
  const textClassName = layout === "stacked" ? "max-w-[760px]" : "";

  return (
    <section id={id} className="border-b border-border bg-sheet">
      <div className={contentClassName}>
        <div className={textClassName}>
          <p className="font-mono text-xs font-semibold text-accent">{index}</p>
          <h2 className="type-display mt-4 sm:text-[44px] sm:leading-[1.05]">{title}</h2>
          <p className="mt-5 text-[15px] leading-7 text-muted sm:text-[16px]">{body}</p>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}
