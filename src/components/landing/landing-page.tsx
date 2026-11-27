import Link from "next/link";

import { LandingProviders, LandingWorkflow } from "@/components/landing/product-mockups";
import { WallieMark } from "@/components/shared/wallie-mark";

import styles from "./landing.module.css";

const docsUrl = "https://github.com/anantjain-xyz/wallie-dev#readme";
const selfHostingUrl =
  "https://github.com/anantjain-xyz/wallie-dev/blob/main/docs/deployment/self-hosting.md";
const licenseUrl = "https://github.com/anantjain-xyz/wallie-dev/blob/main/LICENSE";

export function LandingPage() {
  return (
    <div className={`${styles.page} flex min-h-[100svh] flex-col bg-canvas text-foreground`}>
      <header className="pt-[env(safe-area-inset-top)]">
        <div className={`${styles.content} flex min-h-16 items-center justify-between gap-2`}>
          <Link
            href="/"
            aria-label="Wallie home"
            className="flex min-h-11 items-center gap-2 rounded-[6px] text-[20px] font-bold tracking-tight text-foreground hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <WallieMark className="size-7 shrink-0" />
            Wallie
          </Link>
          <nav aria-label="Main navigation">
            <Link
              href="/login"
              className="ui-touch-target inline-flex min-h-11 items-center rounded-[6px] px-2 text-sm font-medium text-muted hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main
        id="main-content"
        aria-labelledby="landing-title"
        tabIndex={-1}
        className="flex flex-1 items-center py-8 max-[360px]:pt-4 lg:py-12"
      >
        <div className={`${styles.content} space-y-8 sm:space-y-10 lg:space-y-12`}>
          <div className="grid gap-6 sm:gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-12">
            <div>
              <h1
                id="landing-title"
                className="max-w-[640px] text-balance text-[38px] font-semibold leading-[1.06] tracking-[-0.035em] text-foreground max-[360px]:text-[34px] sm:text-[48px] lg:text-[54px]"
              >
                Turn a task into a pull request you can trust
              </h1>
              <p className="mt-4 max-w-[470px] text-pretty text-base leading-6 text-muted sm:text-[17px] sm:leading-7">
                Run your coding agent in an isolated sandbox, with your team in control of what gets
                built.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2 sm:mt-6 sm:gap-3">
                <Link
                  href="/login"
                  aria-describedby="hosted-setup"
                  className="ui-button-primary min-h-11 px-4 text-sm font-semibold"
                >
                  Start with email
                </Link>
                <a href={selfHostingUrl} className="ui-button min-h-11 px-4 text-sm">
                  Self-host Wallie
                </a>
              </div>
              <p
                id="hosted-setup"
                className="type-secondary mt-3 max-w-[430px] text-pretty text-muted"
              >
                For a new hosted workspace, connect a GitHub repository, a sandbox, and your agent
                credentials. Linear is optional.
              </p>
            </div>

            <LandingWorkflow />
          </div>
          <LandingProviders />
        </div>
      </main>

      <footer className="pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div
          className={`${styles.content} type-secondary flex flex-wrap items-center justify-between gap-x-6 text-muted`}
        >
          <p>
            Open source under the{" "}
            <a
              href={licenseUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center underline decoration-border-strong underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              MIT License
            </a>
          </p>
          <a
            href={docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex min-h-11 items-center underline decoration-border-strong underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Docs &amp; source
          </a>
        </div>
      </footer>
    </div>
  );
}
