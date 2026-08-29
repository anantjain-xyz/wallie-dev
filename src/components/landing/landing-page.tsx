import Link from "next/link";

import { StackWorkflowMockup } from "@/components/landing/product-mockups";
import { GitHubIcon } from "@/components/shared/icons/github-icon";

const githubUrl = "https://github.com/anantjain-xyz/wallie-dev";
const docsUrl = "https://github.com/anantjain-xyz/wallie-dev#readme";
const licenseUrl = "https://github.com/anantjain-xyz/wallie-dev/blob/main/LICENSE";

export function LandingPage() {
  return (
    <main id="main-content" className="flex min-h-[100svh] flex-col bg-canvas text-foreground">
      <header className="pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex min-h-16 w-full max-w-[1120px] items-center justify-between gap-4 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))] sm:pr-[max(2rem,env(safe-area-inset-right))]">
          <Link
            href="/"
            aria-label="Wallie home"
            className="flex min-h-11 items-center rounded-[6px] px-1 text-[20px] font-bold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Wallie
          </Link>
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ui-touch-target inline-flex min-h-11 items-center gap-2 rounded-[6px] px-2 text-[14px] font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <GitHubIcon className="h-4 w-4" />
            GitHub
          </a>
        </div>
      </header>

      <section
        aria-labelledby="landing-title"
        className="flex flex-1 items-center px-5 py-10 sm:px-8 lg:px-10"
      >
        <div className="mx-auto grid w-full max-w-[1120px] gap-12 lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:gap-16">
          <div>
            <h1
              id="landing-title"
              className="max-w-[640px] text-[38px] font-semibold leading-[1.06] tracking-[-0.035em] text-foreground sm:text-[48px] lg:text-[54px]"
            >
              Run coding agents through your team&apos;s workflow
            </h1>
            <p className="mt-5 max-w-[540px] text-[16px] leading-7 text-muted sm:text-[17px] sm:leading-8">
              Define the stages of your delivery process, gate each one behind the right reviewer,
              and let agents do the work in isolated sandboxes.
            </p>
            <Link
              href="/login"
              className="ui-touch-target mt-8 inline-flex min-h-11 items-center justify-center rounded-[6px] border border-accent bg-accent px-5 text-[14px] font-semibold text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Sign in to Wallie
            </Link>
          </div>

          <StackWorkflowMockup />
        </div>
      </section>

      <footer className="pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 text-[13px] text-muted sm:px-8 lg:px-10">
          <p>
            Open source under the{" "}
            <a
              href={licenseUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:text-accent"
            >
              MIT License
            </a>
          </p>
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center hover:text-foreground focus-visible:outline-none focus-visible:text-accent"
          >
            Docs
          </a>
        </div>
      </footer>
    </main>
  );
}
