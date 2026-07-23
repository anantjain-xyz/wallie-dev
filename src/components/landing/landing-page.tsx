import Link from "next/link";

import {
  ExpertApprovalMockup,
  PipelineBoardMockup,
  StackWorkflowMockup,
  ValidationProofMockup,
} from "@/components/landing/product-mockups";
import { GitHubIcon } from "@/components/shared/icons/github-icon";

const githubUrl = "https://github.com/anantjain-xyz/wallie-dev";
const docsUrl = "https://github.com/anantjain-xyz/wallie-dev#readme";
const licenseUrl = "https://github.com/anantjain-xyz/wallie-dev/blob/main/LICENSE";

const primaryCtaClassName =
  "ui-touch-target inline-flex min-h-11 items-center justify-center rounded-[6px] border border-accent bg-accent px-5 text-[14px] font-semibold text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-sheet";

const secondaryCtaClassName =
  "ui-touch-target inline-flex min-h-11 items-center justify-center rounded-[6px] border border-border bg-sheet px-5 text-[14px] font-semibold text-foreground transition-colors hover:border-border-strong hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-sheet";

export function LandingPage() {
  return (
    <main id="main-content" className="min-h-[100svh] bg-canvas text-foreground">
      <LandingHeader />

      <section
        aria-labelledby="landing-title"
        className="border-b border-border bg-sheet px-5 py-16 sm:px-8 sm:py-20 lg:px-10 lg:py-24"
      >
        <div className="mx-auto grid w-full max-w-[1080px] gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-16">
          <div>
            <h1
              id="landing-title"
              className="max-w-[760px] text-[42px] font-semibold leading-[1.02] tracking-[-0.045em] text-foreground sm:text-[60px] lg:text-[72px]"
            >
              The Future of Software Factories is Multiplayer
            </h1>
            <p className="mt-6 max-w-[620px] text-[17px] leading-8 text-muted sm:text-[18px]">
              Wallie lets you define your team&apos;s workflow, add approval gates between stages,
              and run coding agents to process each stage in isolated sandboxed environments.
            </p>
            <div className="mt-8 flex flex-col gap-3 min-[420px]:flex-row">
              <Link href="/login" className={primaryCtaClassName}>
                Sign in to Wallie
              </Link>
              <a href="#product-walkthrough" className={secondaryCtaClassName}>
                See the product walkthrough
              </a>
            </div>
          </div>

          <PipelineBoardMockup />
        </div>
      </section>

      <section
        id="product-walkthrough"
        tabIndex={-1}
        aria-labelledby="stack-workflow-title"
        className="scroll-mt-20 border-b border-border bg-canvas px-5 py-14 outline-none sm:px-8 sm:py-18 lg:px-10"
      >
        <StorySection
          id="stack-workflow-title"
          title="Bring your agents. Design your workflow."
          body="Use the coding-agent access you already pay for, pair it with the sandbox provider you prefer, and shape every stage and approval gate around your team. Wallie is open source, MIT licensed, and built to stay provider-agnostic."
        >
          <StackWorkflowMockup />
        </StorySection>
      </section>

      <section
        aria-labelledby="expert-approval-title"
        className="border-b border-border bg-sheet px-5 py-14 sm:px-8 sm:py-18 lg:px-10"
      >
        <StorySection
          id="expert-approval-title"
          title="Let the right experts move work forward."
          body="Choose who reviews each stage. An engineer can approve the plan, a designer can approve visual changes, and the next stage begins only when the right approval arrives."
          reverse
        >
          <ExpertApprovalMockup />
        </StorySection>
      </section>

      <section
        aria-labelledby="validation-proof-title"
        className="border-b border-border bg-canvas px-5 py-14 sm:px-8 sm:py-18 lg:px-10"
      >
        <StorySection
          id="validation-proof-title"
          title="Bring review-ready PRs, with the proof attached."
          body="Wallie completes the loop with the checks your workflow requires—from tests and typechecks to end-to-end flows and visual evidence—so your team reviews work that is ready to ship."
        >
          <ValidationProofMockup />
        </StorySection>
      </section>

      <section
        aria-labelledby="final-cta-title"
        className="bg-sheet px-5 py-16 sm:px-8 sm:py-20 lg:px-10"
      >
        <div className="mx-auto flex w-full max-w-[860px] flex-col items-start rounded-[10px] border border-border bg-canvas p-6 shadow-[var(--shadow-elevated)] sm:items-center sm:p-10 sm:text-center">
          <h2 id="final-cta-title" className="type-display sm:text-[42px] sm:leading-[1.1]">
            Direct your team&apos;s attention to where it has the most leverage
          </h2>
          <p className="mt-4 max-w-[560px] text-[15px] leading-7 text-muted">
            Sign in, design your workspace, and start working through your backlog.
          </p>
          <Link href="/login" className={`${primaryCtaClassName} mt-7`}>
            Sign in to Wallie
          </Link>
        </div>
      </section>

      <LandingFooter />
    </main>
  );
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-sheet/95 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-sheet/85">
      <div className="mx-auto flex min-h-16 w-full max-w-[1180px] items-center justify-between gap-4 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))] sm:pr-[max(2rem,env(safe-area-inset-right))] lg:pl-[max(2.5rem,env(safe-area-inset-left))] lg:pr-[max(2.5rem,env(safe-area-inset-right))]">
        <Link
          href="/"
          aria-label="Wallie home"
          className="flex min-h-11 items-center rounded-[6px] px-1 text-[22px] font-bold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Wallie
        </Link>
        <Link href="/login" className={primaryCtaClassName}>
          Sign in
        </Link>
      </div>
    </header>
  );
}

function StorySection({
  body,
  children,
  id,
  reverse = false,
  title,
}: {
  body: string;
  children: React.ReactNode;
  id: string;
  reverse?: boolean;
  title: string;
}) {
  return (
    <div
      className={`mx-auto grid w-full max-w-[1080px] gap-8 lg:grid-cols-2 lg:items-center lg:gap-14 ${reverse ? "lg:[&>*:first-child]:order-2" : ""}`}
    >
      <div>
        <h2 id={id} className="type-display sm:text-[42px] sm:leading-[1.1]">
          {title}
        </h2>
        <p className="mt-5 max-w-[560px] text-[15px] leading-7 text-muted sm:text-[16px]">{body}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-border bg-sheet">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-8 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
        <p className="text-[13px] text-muted">Wallie is open source and MIT licensed.</p>
        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center gap-x-5 gap-y-3 text-[13px] text-muted"
        >
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center hover:text-foreground focus-visible:outline-none focus-visible:text-accent"
          >
            Docs
          </a>
          <a
            href={licenseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center hover:text-foreground focus-visible:outline-none focus-visible:text-accent"
          >
            MIT License
          </a>
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center gap-2 hover:text-foreground focus-visible:outline-none focus-visible:text-accent"
          >
            <GitHubIcon className="h-4 w-4" />
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
