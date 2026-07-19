import Image from "next/image";
import Link from "next/link";

import {
  ArtifactDecisionMockup,
  IssueInputMockup,
  PipelineProgressMockup,
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
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.16em] text-accent">
              From issue to approved artifact
            </p>
            <h1
              id="landing-title"
              className="mt-5 max-w-[760px] text-[42px] font-semibold leading-[1.02] tracking-[-0.045em] text-foreground sm:text-[60px] lg:text-[72px]"
            >
              Turn Linear issues into reviewed, staged work.
            </h1>
            <p className="mt-6 max-w-[620px] text-[17px] leading-8 text-muted sm:text-[18px]">
              Wallie carries one issue through your workspace pipeline, preserving a reviewable
              artifact at every human gate.
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

          <div
            className="rounded-[10px] border border-border bg-canvas p-4 shadow-[var(--shadow-elevated)] sm:p-5"
            aria-label="Wallie workflow summary"
          >
            <ol className="grid gap-3">
              {[
                ["01", "Linear issue", "OP-349 ready"],
                ["02", "Pipeline", "Plan → Build → Land"],
                ["03", "Artifact review", "Awaiting approval"],
              ].map(([index, label, value]) => (
                <li
                  key={index}
                  className="grid grid-cols-[34px_minmax(0,1fr)] gap-3 rounded-[6px] border border-border bg-sheet p-4"
                >
                  <span className="font-mono text-xs font-semibold text-accent">{index}</span>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-foreground">{label}</p>
                    <p className="mt-1 truncate font-mono text-xs text-muted">{value}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section
        id="product-walkthrough"
        tabIndex={-1}
        aria-labelledby="issue-input-title"
        className="scroll-mt-20 border-b border-border bg-canvas px-5 py-14 outline-none sm:px-8 sm:py-18 lg:px-10"
      >
        <StorySection
          eyebrow="01 · Start with the source"
          title="Bring the Linear issue into focus."
          body="Link the issue to a new session so its title and source stay attached to the work moving through Wallie."
        >
          <IssueInputMockup />
        </StorySection>
      </section>

      <section
        aria-labelledby="pipeline-title"
        className="border-b border-border bg-sheet px-5 py-14 sm:px-8 sm:py-18 lg:px-10"
      >
        <StorySection
          eyebrow="02 · Follow the pipeline"
          title="See exactly which stage owns the work."
          body="The session advances through the workspace’s ordered stages. Each handoff stays visible without compressing a desktop dashboard onto a phone."
          reverse
        >
          <PipelineProgressMockup />
        </StorySection>
      </section>

      <section
        aria-labelledby="artifact-title"
        className="border-b border-border bg-canvas px-5 py-14 sm:px-8 sm:py-18 lg:px-10"
      >
        <StorySection
          eyebrow="03 · Make the decision"
          title="Review the artifact, then approve or return it."
          body="Every stage produces a versioned markdown artifact. A reviewer decides whether the session advances or reruns with feedback."
        >
          <ArtifactDecisionMockup />
        </StorySection>
      </section>

      <section
        aria-labelledby="trust-title"
        className="border-b border-border bg-sheet px-5 py-14 sm:px-8 sm:py-18 lg:px-10"
      >
        <div className="mx-auto w-full max-w-[1080px]">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-accent">
            Human control, kept explicit
          </p>
          <h2
            id="trust-title"
            className="type-display mt-4 max-w-[680px] sm:text-[42px] sm:leading-[1.1]"
          >
            Boundaries your team can see.
          </h2>
          <div className="mt-8 grid gap-px overflow-hidden rounded-[6px] border border-border bg-border md:grid-cols-3">
            {[
              [
                "Human approval gates",
                "A reviewer approves or rejects the artifact before the next stage begins.",
              ],
              [
                "Workspace isolation",
                "Sessions, pipelines, artifacts, and secrets remain scoped to their workspace.",
              ],
              [
                "Integration boundaries",
                "Linear supplies issue context; GitHub and the configured runtime handle their connected parts.",
              ],
            ].map(([title, body]) => (
              <article key={title} className="bg-sheet p-5 sm:p-6">
                <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
                <p className="mt-3 text-[14px] leading-6 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section
        aria-labelledby="final-cta-title"
        className="bg-canvas px-5 py-16 sm:px-8 sm:py-20 lg:px-10"
      >
        <div className="mx-auto flex w-full max-w-[860px] flex-col items-start rounded-[10px] border border-border bg-sheet p-6 shadow-[var(--shadow-elevated)] sm:items-center sm:p-10 sm:text-center">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-accent">
            Keep the next handoff reviewable
          </p>
          <h2 id="final-cta-title" className="type-display mt-4 sm:text-[42px] sm:leading-[1.1]">
            Start with the issue your team already has.
          </h2>
          <p className="mt-4 max-w-[560px] text-[15px] leading-7 text-muted">
            Sign in, choose a workspace, and create the session that carries it through your
            pipeline.
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
          className="flex min-h-11 items-center gap-2.5 rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Image
            src="/wallie-logo-minimal.png"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9 rounded-[6px] object-contain dark:invert"
            priority
          />
          <span className="text-[15px] font-semibold text-foreground">Wallie</span>
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
  eyebrow,
  reverse = false,
  title,
}: {
  body: string;
  children: React.ReactNode;
  eyebrow: string;
  reverse?: boolean;
  title: string;
}) {
  const titleId = eyebrow.startsWith("01")
    ? "issue-input-title"
    : eyebrow.startsWith("02")
      ? "pipeline-title"
      : "artifact-title";

  return (
    <div
      className={`mx-auto grid w-full max-w-[1080px] gap-8 lg:grid-cols-2 lg:items-center lg:gap-14 ${reverse ? "lg:[&>*:first-child]:order-2" : ""}`}
    >
      <div>
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-accent">
          {eyebrow}
        </p>
        <h2 id={titleId} className="type-display mt-4 sm:text-[42px] sm:leading-[1.1]">
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
