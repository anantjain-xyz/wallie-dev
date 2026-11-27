import Link from "next/link";

import { WallieMark } from "@/components/shared/wallie-mark";

import { FactoryRevision } from "./factory-revision";
import styles from "./landing.module.css";
import { WorkOrder } from "./work-order";

export const factoryTourHeading = "Self-improving software factory";

const docsUrl = "https://github.com/anantjain-xyz/wallie-dev#readme";
const selfHostingUrl =
  "https://github.com/anantjain-xyz/wallie-dev/blob/main/docs/deployment/self-hosting.md";
const licenseUrl = "https://github.com/anantjain-xyz/wallie-dev/blob/main/LICENSE";
const workOrderTitle = "Add a dry-run mode to the deploy CLI.";

function TourBrand() {
  return (
    <a className={styles.brand} href="#top" aria-label="Wallie, back to top">
      <WallieMark />
      <span>Wallie</span>
    </a>
  );
}

export function LandingPage() {
  return (
    <div className={styles.page}>
      <header
        className={`${styles.mast} ${styles.shell}`}
        id="top"
        tabIndex={-1}
        aria-label="Wallie"
      >
        <TourBrand />
        <nav className={styles.mastNav} aria-label="Tour stops">
          <a href="#studio">
            <span aria-hidden="true">01</span> Studio
          </a>
          <a href="#line">
            <span aria-hidden="true">02</span> The line
          </a>
          <a href="#improve">
            <span aria-hidden="true">03</span> Improvements
          </a>
        </nav>
        <a className={styles.mastTry} href="#start">
          Try Wallie <span aria-hidden="true">↘</span>
        </a>
      </header>

      <main id="main-content" tabIndex={-1} aria-labelledby="hero-title">
        <section className={`${styles.hero} ${styles.shell}`} aria-labelledby="hero-title">
          <div className={styles.heroGrid}>
            <div>
              <p className={`${styles.technical} ${styles.tourLabel}`}>
                <span className={styles.railMark} aria-hidden="true" /> The Wallie factory tour
              </p>
              <h1 id="hero-title">{factoryTourHeading}</h1>
              <p className={styles.heroDeck}>
                Give your coding agents a workflow. Turn a task into reviewed code, then use what
                you find to improve the next job.
              </p>
              <a className={`${styles.button} ${styles.primary}`} href="#studio">
                Start the tour{" "}
                <span className={styles.arrow} aria-hidden="true">
                  ↓
                </span>
              </a>
            </div>
            <figure className={styles.heroFigure}>
              <svg
                className={styles.factoryArt}
                viewBox="0 0 720 440"
                role="img"
                aria-labelledby="factory-title"
                aria-describedby="factory-desc"
              >
                <title id="factory-title">Cutaway drawing of the Wallie software factory</title>
                <desc id="factory-desc">
                  A terminal and drafting bench feed a roller conveyor. It carries the highlighted
                  work order through an inspection gantry toward a dispatch crate. A marked return
                  path leads back to the studio.
                </desc>
                <use href="/factory-tour-cutaway.svg#factory-cutaway" />
              </svg>
              <figcaption className={`${styles.technical} ${styles.figureLegend}`}>
                <span>Fig. A — Factory cutaway</span>
                <span>Illustration / not to scale</span>
              </figcaption>
            </figure>
          </div>
          <div className={styles.boarding} role="group" aria-label="The sample work order">
            <div className={`${styles.boardingId} ${styles.technical}`}>
              <span className={styles.ticketIcon} aria-hidden="true" /> Work order 024
            </div>
            <strong>{workOrderTitle}</strong>
            <span className={styles.boardingNote}>
              A fictional job. Follow it through all three stops.
            </span>
          </div>
        </section>

        <div className={`${styles.tour} ${styles.shell}`}>
          <section
            className={styles.chapter}
            id="studio"
            aria-labelledby="studio-title"
            tabIndex={-1}
          >
            <div className={`${styles.chapterIndex} ${styles.technical}`}>
              <span className={styles.indexPin} aria-hidden="true">
                01
              </span>{" "}
              In the studio
            </div>
            <div className={styles.studioLayout}>
              <div className={styles.chapterCopy}>
                <h2 id="studio-title">
                  Set up the
                  <br className={styles.wideBreak} /> line once.
                </h2>
                <p>
                  A <strong>factory</strong> is the setup you reuse: its repository, the stages your
                  agent works through, and who reviews them. A <strong>session</strong> is one task
                  moving through that setup.
                </p>
                <p>
                  A workspace owner or admin can edit the definition in structured fields or JSON,
                  then test and publish a revision for new sessions.
                </p>
              </div>
              <figure className={styles.definitionSheet}>
                <figcaption className={`${styles.plateCap} ${styles.technical}`}>
                  <span>Shop drawing / Factory definition</span>
                  <span>R07 · Active</span>
                </figcaption>
                <div className={styles.sheetContent}>
                  <div className={styles.sheetHeading}>
                    <h3>Release CLI</h3>
                    <span className={styles.technical}>Serial pipeline</span>
                  </div>
                  <svg
                    className={styles.elevation}
                    viewBox="0 0 540 171"
                    role="img"
                    aria-label="Front elevation of the planning bench and the build station on the same rail"
                  >
                    <g fill="none" stroke="var(--art-guide)" strokeLinejoin="round" strokeWidth="1">
                      <path d="M18 47V11h504v36M27 23h486M270 11v124" strokeDasharray="3 4" />
                      <path d="M18 140v18h504v-18M117 146v12m153-12v12m153-12v12" />
                      <path d="m13 16 10-10m494 10 10-10M13 163l10-10m494 10 10-10" />
                      <path d="M62 93H31m35-50H31m8 0v50M495 33h21m-21 60h21m-7-60v60" />
                    </g>
                    <g
                      fill="var(--paper)"
                      stroke="var(--art-ink)"
                      strokeWidth="1.65"
                      strokeLinejoin="round"
                    >
                      <path d="M78 98v25h10v-25m87 0v25h10v-25m-110-9h116v9H75z" />
                      <rect x="90" y="43" width="63" height="34" rx="2" />
                      <path d="M97 50h49v20H97zm21 27v6m-9 2h23m25 1 14-9h12l-3 9z" />
                      <path d="M105 56l5 4-5 4m10 0h8M166 82h8" />
                      <path d="M357 123V39h118v84m-106 0V53h94v70M352 33h128v12H352zm5 80h12m94 0h12" />
                      <path d="M381 53v25m70-25v25M379 77h74v7h-74zm29 7v11h16V84m-12 11v7h8v-7" />
                      <path d="M379 37h28m6 0h13m10 0h26M456 27h12v6h-12z" />
                      <path d="M28 123h484v13H28zM43 136v9m136-9v9m182-9v9m135-9v9" />
                      <path d="M46 130h447" strokeDasharray="4 7" />
                    </g>
                    <g
                      fill="var(--art-index)"
                      fontFamily="ui-monospace,monospace"
                      fontSize="11"
                      textAnchor="middle"
                    >
                      <text x="129" y="20">
                        01
                      </text>
                      <text x="418" y="20">
                        02
                      </text>
                    </g>
                  </svg>
                  <ol className={styles.stageSpec} role="list">
                    <li>
                      <span className={styles.technical} aria-hidden="true">
                        01
                      </span>
                      <div>
                        <strong>Plan</strong>
                        <span>Write a plan from the task.</span>
                        <small>Maintainer reviews the plan.</small>
                      </div>
                    </li>
                    <li>
                      <span className={styles.technical} aria-hidden="true">
                        02
                      </span>
                      <div>
                        <strong>Build</strong>
                        <span>Use the approved plan. Implement and test.</span>
                        <small>Maintainer reviews the result.</small>
                      </div>
                    </li>
                  </ol>
                  <details className={styles.sheetDetail}>
                    <summary>Open the definition sheet</summary>
                    <dl className={styles.specList}>
                      <div>
                        <dt>GitHub repository</dt>
                        <dd>
                          <code>tour-works/deploy-cli</code> (example)
                        </dd>
                      </div>
                      <div>
                        <dt>Agent and sandbox</dt>
                        <dd>Codex in a connected Vercel Sandbox (example)</dd>
                      </div>
                      <div>
                        <dt>Build prompt</dt>
                        <dd>
                          “Use the approved Plan artifact. Implement the change and test the CLI
                          output.”
                        </dd>
                      </div>
                    </dl>
                  </details>
                </div>
              </figure>
            </div>
            <p className={styles.chapterNote}>
              <span className={styles.technical}>Start here</span> The default pipeline starts with
              Plan and Build. For a separate factory, an owner or admin assigns a connected
              repository and publishes its pipeline before starting sessions.
            </p>
          </section>

          <section className={styles.chapter} id="line" aria-labelledby="line-title" tabIndex={-1}>
            <div className={`${styles.chapterIndex} ${styles.technical}`}>
              <span className={styles.indexPin} aria-hidden="true">
                02
              </span>{" "}
              On the line
            </div>
            <div className={styles.chapterLead}>
              <h2 id="line-title">
                Put a change
                <br className={styles.wideBreak} /> on the line.
              </h2>
              <p>
                Type a task, or link a Linear issue if it’s connected and enabled for intake. Wallie
                runs the factory’s stages in a sandbox and pauses for the people you’ve assigned to
                review.
              </p>
            </div>
            <section className={styles.lineDeck} aria-labelledby="order-title">
              <div className={styles.deckHead}>
                <p className={`${styles.technical} ${styles.deckLabel}`}>
                  <span className={styles.ticketIcon} aria-hidden="true" /> Work order 024
                  <span className={styles.deckDivider} aria-hidden="true">
                    /
                  </span>{" "}
                  Tour simulation
                </p>
                <h3 id="order-title">{workOrderTitle}</h3>
                <p>Pick a station to move the work order. Nothing runs outside this tour.</p>
              </div>
              <WorkOrder />
            </section>
            <p className={styles.chapterNote}>
              <span className={styles.technical}>Dispatch</span> With delivery configured, code
              changes can go to a GitHub PR. Approving the Wallie artifact doesn’t merge it.
            </p>
          </section>

          <section
            className={`${styles.chapter} ${styles.returnChapter}`}
            id="improve"
            aria-labelledby="return-title"
            tabIndex={-1}
          >
            <div className={`${styles.chapterIndex} ${styles.technical}`}>
              <span className={styles.indexPin} aria-hidden="true">
                03
              </span>{" "}
              Back to the studio
            </div>
            <div className={`${styles.chapterLead} ${styles.short}`}>
              <h2 id="return-title">
                Bring the finding
                <br className={styles.wideBreak} /> back.
              </h2>
              <p>
                Requesting changes fixed this job. It didn’t edit the factory. Take the finding back
                to the definition so the next session can start with a better instruction.
              </p>
            </div>
            <section aria-labelledby="bench-title">
              <h3 id="bench-title" className="sr-only">
                Manual factory revision demonstration
              </h3>
              <FactoryRevision>
                <div className={styles.returnSlip}>
                  <div className={`${styles.slipCap} ${styles.technical}`}>
                    <span>From the line</span>
                    <span>WO–024</span>
                  </div>
                  <p>“Dry runs must never call the deploy API.”</p>
                  <div className={`${styles.slipFoot} ${styles.technical}`}>
                    <span>Session review / One job</span>
                    <strong>Build v1 → v2</strong>
                  </div>
                </div>
                <div className={styles.returnArrow}>
                  <svg viewBox="0 0 110 68" aria-hidden="true">
                    <path
                      d="M3 46h36c15 0 19-26 34-26h30m-9-8 9 8-9 8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.65"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray="3 4"
                    />
                    <circle cx="3" cy="46" r="2.7" fill="currentColor" />
                  </svg>
                  <span className={styles.technical}>
                    A person
                    <br /> edits the factory
                  </span>
                </div>
              </FactoryRevision>
            </section>

            <section className={styles.advanced} aria-labelledby="advanced-title">
              <div className={styles.advancedIntro}>
                <p className={`${styles.technical} ${styles.availability}`}>
                  <span aria-hidden="true">◇</span> Configured path · rollout varies
                </p>
                <h3 id="advanced-title">
                  When a failure
                  <br className={styles.wideBreak} /> repeats.
                </h3>
                <p>
                  A single review note is enough for the manual path above. With enough comparable
                  failures across sessions, a configured factory can test a proposed fix against
                  real examples.
                </p>
              </div>
              <div>
                <ol className={styles.learningList} role="list">
                  <li>
                    <span className={styles.technical} aria-hidden="true">
                      01
                    </span>
                    <div>
                      <strong>Find the pattern.</strong> Wallie groups failures from validation
                      checks and scorers. The group links back to the evidence; it doesn’t prove a
                      cause.
                    </div>
                  </li>
                  <li>
                    <span className={styles.technical} aria-hidden="true">
                      02
                    </span>
                    <div>
                      <strong>Ask for a diagnosis.</strong> A factory manager starts it. A diagnosis
                      agent reads frozen failure records and suggests possible causes with
                      citations. The manager writes the proposed change.
                    </div>
                  </li>
                  <li>
                    <span className={styles.technical} aria-hidden="true">
                      03
                    </span>
                    <div>
                      <strong>Test the exact revision.</strong> Compare it with the active
                      definition on both related tasks and a separate set to catch regressions.
                    </div>
                  </li>
                  <li>
                    <span className={styles.technical} aria-hidden="true">
                      04
                    </span>
                    <div>
                      <strong>Review, then adopt.</strong> A manager requests a separate
                      configuration PR once the candidate qualifies. After independent GitHub
                      approval and merge, a Wallie owner or admin can adopt that tested revision for
                      new sessions.
                    </div>
                  </li>
                </ol>
                <p className={styles.advancedNote}>
                  Diagnosis and proposal setup use authorized APIs. The full path needs an approved
                  inference profile, a compatible benchmark worker, and a GitHub branch for the
                  definition. It isn’t a fresh-workspace default.
                </p>
              </div>
            </section>
          </section>
        </div>

        <section
          className={`${styles.start} ${styles.shell}`}
          id="start"
          aria-labelledby="start-title"
          tabIndex={-1}
        >
          <div className={styles.startMain}>
            <div className={styles.startCopy}>
              <p className={`${styles.technical} ${styles.tourLabel}`}>
                <span className={styles.railMark} aria-hidden="true" /> End of the tour
              </p>
              <h2 id="start-title">Make it your line.</h2>
              <p id="hosted-setup">
                For a hosted workspace, connect your GitHub repository, a sandbox, and your coding
                agent credentials. Linear is optional. You can also run Wallie yourself.
              </p>
            </div>
            <div className={styles.startActions}>
              <Link
                href="/login"
                prefetch={false}
                className={`${styles.button} ${styles.primary}`}
                aria-describedby="hosted-setup"
              >
                Try hosted Wallie{" "}
                <span className={styles.arrow} aria-hidden="true">
                  ↗
                </span>
              </Link>
              <a href={selfHostingUrl} className={`${styles.button} ${styles.ghost}`}>
                Self-host Wallie{" "}
                <span className={styles.arrow} aria-hidden="true">
                  ↗
                </span>
              </a>
              <p className={styles.exitNote}>
                Destinations: Wallie sign-in and the GitHub self-hosting guide.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className={`${styles.footer} ${styles.shell}`} aria-label="Page footer">
        <TourBrand />
        <div className={styles.footerMeta}>
          <p>Illustrated concept. All work orders and results are fictional.</p>
          <div className={styles.footerLinks}>
            <a href={docsUrl}>Docs &amp; source</a>
            <a href={licenseUrl}>MIT License</a>
          </div>
        </div>
        <a href="#top" className={styles.topLink}>
          Back to the gate <span aria-hidden="true">↑</span>
        </a>
      </footer>
    </div>
  );
}
