import { AdoptionReceipt } from "./adoption-receipt";
import styles from "./landing.module.css";

const earlierOrders = ["WO–019", "WO–021", "WO–023"] as const;

export function ImproveChapter() {
  return (
    <section
      className={`${styles.chapter} ${styles.improve}`}
      id="improve"
      aria-labelledby="improve-title"
      tabIndex={-1}
    >
      <div className={`${styles.chapterIndex} ${styles.technical}`}>
        <span className={styles.indexPin} aria-hidden="true">
          03
        </span>{" "}
        Improve
      </div>
      <div className={styles.chapterLead}>
        <h2 id="improve-title">
          Make the next
          <br className={styles.wideBreak} /> run better.
        </h2>
        <p>
          Review fixed 024, not R07. Over time, comparable failures across jobs can show what to
          test in a better starting revision.
        </p>
      </div>

      <div className={styles.benchLayout}>
        <section className={styles.benchModule} aria-labelledby="pattern-title">
          <p className={`${styles.technical} ${styles.muted}`}>01 / Pattern over time</p>
          <h3 id="pattern-title">Find what keeps failing.</h3>
          <p>
            The review note on 024 is a lead, not a failed check or scorer result. Earlier jobs
            recorded the failure. Wallie can group comparable failures and link back to their runs.
          </p>
          <div
            className={styles.evidencePlate}
            role="group"
            aria-label="Repeated deploy call checks"
          >
            <p className={`${styles.plateCap} ${styles.technical}`}>
              <span>Unexpected deploy call</span>
              <span>Earlier jobs</span>
            </p>
            <ul
              className={styles.sourceList}
              role="list"
              aria-label="Earlier jobs with the same failure"
            >
              {earlierOrders.map((order) => (
                <li key={order}>
                  <b>{order}</b>
                  <span>Build · R07</span>
                  <strong>Check failed</strong>
                </li>
              ))}
            </ul>
            <details className={styles.plateDetail}>
              <summary>Read the WO–023 receipt</summary>
              <p className={styles.smallNote}>
                <strong>Mock deploy check:</strong> expected 0 calls in a dry run, observed 1. The
                receipt identifies the WO–023 Build run on R07. A pattern gives you something to
                investigate. It doesn’t prove the cause.
              </p>
            </details>
          </div>
        </section>

        <section className={styles.benchModule} aria-labelledby="proposal-title">
          <p className={`${styles.technical} ${styles.muted}`}>02 / Candidate change</p>
          <h3 id="proposal-title">Change one instruction.</h3>
          <p>
            A factory manager proposes adding the missing check to Build. Where configured, a
            diagnosis can suggest possible causes from the captured evidence. It doesn’t edit the
            factory.
          </p>
          <figure className={styles.evidencePlate}>
            <figcaption className={`${styles.plateCap} ${styles.technical}`}>
              <span>Change order / Build prompt</span>
              <span>Before adoption</span>
            </figcaption>
            <dl className={styles.patch}>
              <div>
                <dt>
                  R07 <small>Active</small>
                </dt>
                <dd>Implement the change and test the CLI output.</dd>
              </div>
              <div className={styles.accent}>
                <dt>
                  R08 <small>Candidate</small>
                </dt>
                <dd>
                  <span aria-hidden="true">+</span> Check that a dry run never calls the deploy API.
                </dd>
              </div>
            </dl>
            <p className={`${styles.plateNote} ${styles.smallNote}`}>
              The stages, approvers, and run limits don’t change.
            </p>
          </figure>
        </section>
      </div>

      <section className={styles.compareBench} aria-labelledby="comparison-title">
        <div className={styles.compareHead}>
          <div>
            <p className={`${styles.technical} ${styles.muted}`}>03 / Comparable evidence</p>
            <h3 id="comparison-title">Test the fix. Check for regressions.</h3>
          </div>
          <p className={styles.smallNote}>
            <strong>Configured benchmark path.</strong> Replay the same tasks against both
            revisions. Use a separate set of tasks to catch regressions.
          </p>
        </div>
        <figure className={styles.evidencePlate}>
          <figcaption className={`${styles.plateCap} ${styles.technical}`}>
            <span>Matched run bench</span>
            <span>Example comparison / Before adoption</span>
          </figcaption>
          <table
            className={styles.gateTable}
            aria-label="Targeted and independent holdout comparisons"
          >
            <thead>
              <tr>
                <th scope="col">Matched check</th>
                <th scope="col">
                  <b>R07</b>
                  <span>Baseline</span>
                </th>
                <th scope="col">
                  <b>R08</b>
                  <span>Candidate</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <span className={styles.technical}>Targeted task</span> Dry run skips the deploy
                  call
                </th>
                <td>
                  Fails<small>1 mock call</small>
                </td>
                <td className={styles.accent}>
                  Passes<small>0 mock calls</small>
                </td>
              </tr>
              <tr>
                <th scope="row">
                  <span className={styles.technical}>Independent holdout</span> Invalid config
                  reports an error
                </th>
                <td>
                  Passes<small>Error shown</small>
                </td>
                <td>
                  Passes<small>Error shown</small>
                </td>
              </tr>
            </tbody>
          </table>
          <p className={`${styles.plateNote} ${styles.smallNote}`}>
            Same task and scoring within each pair. Two illustrative rows don’t qualify a revision.
          </p>
        </figure>
        <div className={`${styles.qualification} ${styles.smallNote}`}>
          <p>
            <strong>To qualify:</strong> improve on the targeted tasks and meet agreed thresholds on
            both suites, with enough eligible evidence.
          </p>
          <p>
            <strong>Not a default:</strong> factory managers use authorized APIs for diagnosis,
            proposals, and validation. Diagnosis needs approved inference; replay needs a configured
            connection, a compatible worker, and retained inputs.
          </p>
        </div>
      </section>

      <section className={styles.decision} aria-labelledby="decision-title">
        <div className={styles.decisionCopy}>
          <p className={`${styles.technical} ${styles.muted}`}>04 / Human decision</p>
          <h3 id="decision-title">Adopt it for new work.</h3>
          <p>
            Once R08 qualifies, a factory manager uses the API to request a draft configuration PR
            on a dedicated GitHub branch. The exact PR head needs independent human approval and
            must be merged in GitHub. A workspace owner or admin then adopts it separately in
            Wallie.
          </p>
          <p className={styles.smallNote}>
            This is a definition PR, separate from any code PR for 024. Passing the benchmark or
            merging doesn’t activate R08.
          </p>
        </div>
        <AdoptionReceipt />
      </section>

      <aside
        className={`${styles.manualNote} ${styles.smallNote}`}
        aria-label="Separate manual publication path"
      >
        <span className={styles.technical}>Without benchmark setup</span> A workspace owner or admin
        can edit a draft, pass its configuration handoff test, and publish it for new jobs. That
        test checks the setup, not whether the change improves behavior.
      </aside>
    </section>
  );
}
