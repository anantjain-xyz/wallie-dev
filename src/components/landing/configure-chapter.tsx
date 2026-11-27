import styles from "./landing.module.css";

export function ConfigureChapter() {
  return (
    <section
      className={styles.chapter}
      id="configure"
      aria-labelledby="configure-title"
      tabIndex={-1}
    >
      <div className={`${styles.chapterIndex} ${styles.technical}`} id="studio" tabIndex={-1}>
        <span className={styles.indexPin} aria-hidden="true">
          01
        </span>{" "}
        Configure
      </div>
      <div className={styles.configureLayout}>
        <div className={styles.chapterCopy}>
          <h2 id="configure-title">
            Set the rules
            <br className={styles.wideBreak} /> for the line.
          </h2>
          <p>
            Choose the repo, the stages and their instructions, and when a person signs off. Save
            those rules as a factory definition.
          </p>
          <p className={styles.configTest}>
            <strong>Save, test, then publish.</strong> A workspace owner or admin tests the exact
            saved draft before publishing. The test checks stage handoffs with sample inputs, not
            CLI behavior.
          </p>
        </div>
        <figure className={styles.definitionSheet} aria-labelledby="recipe-name">
          <figcaption className={`${styles.plateCap} ${styles.technical}`}>
            <span>Factory definition plate</span>
            <span>Illustrative setup</span>
          </figcaption>
          <div className={styles.recipeHead}>
            <div>
              <h3 id="recipe-name">Release CLI</h3>
              <p className={styles.technical}>Starting configuration</p>
            </div>
            <div className={styles.plateRevision}>
              <b>R07</b>
              <span className={styles.technical}>Published</span>
            </div>
          </div>
          <dl className={styles.recipeFields}>
            <div>
              <dt className={styles.technical}>Input / repo</dt>
              <dd>Typed task · Connected GitHub repository</dd>
            </div>
          </dl>
          <ol
            className={styles.recipeStages}
            role="list"
            aria-label="Ordered stages and review gates"
          >
            <li>
              <h4 className={styles.stageHeading}>
                <span className={styles.technical} aria-hidden="true">
                  01
                </span>{" "}
                Plan
                <svg viewBox="0 0 31 23" aria-hidden="true">
                  <path d="M3.5 18.5h23v-3h-23zM8.5 15.5v-12h12v12m-9-8h6m-6 3h6M6.5 18.5v3m17-3v3M22 13l4-4 1.5 1.5-4 4" />
                </svg>
              </h4>
              <p>Draft an approach and test plan.</p>
              <p>Assigned reviewer approves the plan.</p>
            </li>
            <li>
              <h4 className={styles.stageHeading}>
                <span className={styles.technical} aria-hidden="true">
                  02
                </span>{" "}
                Build
                <svg viewBox="0 0 31 23" aria-hidden="true">
                  <path d="M2.5 19.5h26m-22 0v-15h18v15m-21-15h24m-12 0v7m-4 0h8m-7 2h6m-8 3h10" />
                </svg>
              </h4>
              <p>Use the approved plan. Implement and test the CLI output.</p>
              <p>Assigned maintainer reviews the build.</p>
            </li>
          </ol>
          <dl className={styles.recipeFields}>
            <div>
              <dt className={styles.technical}>Runtime</dt>
              <dd>Codex · Vercel Sandbox</dd>
            </div>
            <div>
              <dt className={styles.technical}>Run limits</dt>
              <dd>45 min of execution · Up to 2 repairs per session</dd>
            </div>
          </dl>
          <details className={styles.plateDetail}>
            <summary>Read the setup receipt</summary>
            <p className={styles.smallNote}>
              <strong>Saved draft → handoffs checked → published.</strong> A workspace owner or
              admin needs a current passing test for the exact saved draft, an eligible repo and
              approvers, and a ready runtime connection. Queue time and review wait don’t count
              toward the execution cap. Requested revisions and retries count as repairs.
            </p>
          </details>
        </figure>
      </div>
      <div className={styles.chapterNote}>
        <span className={styles.technical}>Starting point</span>
        <p>
          New sessions in this example use published R07. Plan → Build is the starter pipeline; the
          reviewers, runtime, and limits above are examples. A factory needn’t have an active
          definition.
        </p>
      </div>
    </section>
  );
}
