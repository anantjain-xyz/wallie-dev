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

type FeatureSectionProps = {
  body: string;
  children: ReactNode;
  id: string;
  index: string;
  layout?: "split" | "stacked";
  title: string;
};

const nextPath = "/";

export function LandingPage() {
  return (
    <main id="main-content" className="min-h-[100svh] bg-surface text-foreground tracking-normal">
      <LandingHeader />

      <section className="mx-auto flex w-full max-w-[1180px] flex-col px-5 pb-16 pt-12 sm:px-8 sm:pb-20 sm:pt-16 lg:px-10">
        <div className="mx-auto max-w-[860px] text-center">
          <h1 className="font-[var(--font-newsreader)] text-[48px] font-normal leading-[0.96] text-foreground sm:text-[72px] lg:text-[88px]">
            Bring agents together with your team in one shared workspace.
          </h1>
          <p className="mx-auto mt-6 max-w-[720px] text-[17px] leading-8 text-muted sm:text-[18px]">
            Wallie turns product, design, engineering, review, and land stages into gated, sandboxed
            runs your team can inspect and approve together.
          </p>
        </div>

        <div className="mt-12 sm:mt-16">
          <HeroWorkspaceMockup />
        </div>
      </section>

      <div className="border-t border-border bg-background">
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
    </main>
  );
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-5 py-4 sm:px-8 lg:flex-row lg:items-center lg:justify-between lg:px-10">
        <Link href="/" className="flex items-center gap-3 focus-visible:outline-none">
          <Image
            src="/wallie-logo-minimal.png"
            alt=""
            width={44}
            height={44}
            className="h-11 w-11 rounded-[10px] bg-surface object-contain"
            priority
          />
          <span className="text-[16px] font-semibold text-foreground">Wallie</span>
        </Link>

        <div className="w-full lg:max-w-[500px]">
          <EmailMagicLinkForm
            next={nextPath}
            variant="inline"
            className="flex flex-col gap-2 sm:flex-row sm:items-center"
            inputClassName="h-9 w-full rounded-[6px] border border-border bg-surface px-3 text-[13px] text-foreground outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted focus-visible:border-accent/50 focus-visible:shadow-[0_0_0_4px_var(--focus-ring-soft)]"
            submitClassName="inline-flex h-9 shrink-0 items-center justify-center rounded-[6px] border border-accent bg-accent px-4 text-[13px] font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            submitLabel="Get started"
          />
        </div>
      </div>
    </header>
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
    <section id={id} className="border-b border-border bg-surface">
      <div className={contentClassName}>
        <div className={textClassName}>
          <p className="font-mono text-[12px] font-semibold text-accent">{index}</p>
          <h2 className="mt-4 text-[32px] font-semibold leading-[1.05] text-foreground sm:text-[44px]">
            {title}
          </h2>
          <p className="mt-5 text-[15px] leading-7 text-muted sm:text-[16px]">{body}</p>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}
