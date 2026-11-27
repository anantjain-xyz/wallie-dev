import Link from "next/link";

import { WallieMark } from "@/components/shared/wallie-mark";

import { ConfigureChapter } from "./configure-chapter";
import { ImproveChapter } from "./improve-chapter";
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
        <nav className={styles.mastNav} aria-label="Tour chapters">
          <a href="#configure">
            <span aria-hidden="true">01</span> Configure
          </a>
          <a href="#run">
            <span aria-hidden="true">02</span> Run
          </a>
          <a href="#improve">
            <span aria-hidden="true">03</span> Improve
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
                Set up your factory. Let agents run tasks through human review. Use what repeats to
                make the next run better.
              </p>
              <a className={`${styles.button} ${styles.primary}`} href="#configure">
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
        </section>

        <div className={`${styles.tour} ${styles.shell}`}>
          <ConfigureChapter />

          <section className={styles.chapter} id="run" aria-labelledby="run-title" tabIndex={-1}>
            <div className={`${styles.chapterIndex} ${styles.technical}`} id="line" tabIndex={-1}>
              <span className={styles.indexPin} aria-hidden="true">
                02
              </span>{" "}
              Run
            </div>
            <div className={styles.chapterLead}>
              <h2 id="run-title">
                Put a change
                <br className={styles.wideBreak} /> on the line.
              </h2>
              <p>
                Start with a task, or a Linear issue where linking is enabled. Wallie runs the
                stages in a sandbox and pauses for the people you’ve assigned to review.
              </p>
            </div>
            <section className={styles.lineDeck} aria-labelledby="order-title">
              <div className={styles.deckHead}>
                <div>
                  <p className={`${styles.technical} ${styles.deckLabel}`}>
                    <span className={styles.ticketIcon} aria-hidden="true" /> Work order 024{" "}
                    <span className={styles.deckDivider} aria-hidden="true">
                      /
                    </span>{" "}
                    R07
                  </p>
                  <h3 id="order-title">{workOrderTitle}</h3>
                </div>
                <p className={styles.deckInstructions}>
                  Follow this example work order through each station.
                </p>
              </div>
              <WorkOrder />
            </section>
            <aside className={styles.runHandoff} aria-label="What the run leaves behind">
              <div>
                <p className={styles.technical}>From the line / Beyond the artifact</p>
                <p>
                  <strong>A run leaves a trail.</strong> The versioned artifacts, review feedback,
                  and available checks show what happened on this job. They don’t edit R07.
                </p>
              </div>
              <a className={`${styles.button} ${styles.ghost}`} href="#improve">
                Follow the evidence{" "}
                <span className={styles.arrow} aria-hidden="true">
                  ↓
                </span>
              </a>
            </aside>
          </section>

          <ImproveChapter />
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
              <h2 id="start-title">Make your own software factory</h2>
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
            </div>
          </div>
        </section>
      </main>

      <footer className={`${styles.footer} ${styles.shell}`} aria-label="Page footer">
        <TourBrand />
        <div className={styles.footerLinks}>
          <a href={docsUrl}>Docs &amp; source</a>
          <a href={licenseUrl}>MIT License</a>
        </div>
        <a href="#top" className={styles.topLink}>
          Back to the gate <span aria-hidden="true">↑</span>
        </a>
      </footer>
    </div>
  );
}
