"use client";

import { useState, type ReactNode } from "react";

import styles from "./landing.module.css";

const revisionSteps = {
  draft: {
    next: "tested",
    action: "Run configuration test",
    arrow: "→",
    status: "R08 draft / Test needed",
    consequence: "New sessions still start on R07 until you publish.",
  },
  tested: {
    next: "published",
    action: "Publish R08 in the tour",
    arrow: "→",
    status: "R08 draft / Configuration test passed",
    consequence: "The saved draft passed the handoff test. R07 remains active.",
  },
  published: {
    next: "draft",
    action: "Replay the revision",
    arrow: "↺",
    status: "Published / New sessions use R08",
    consequence:
      "The next session gets the new prompt. Work order 024 keeps its original revision.",
  },
} as const;

export function FactoryRevision({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<keyof typeof revisionSteps>("draft");
  const { next, action, arrow, status, consequence } = revisionSteps[step];
  const published = step === "published";

  return (
    <>
      <div className={styles.benchMap}>
        {children}
        <article className={styles.changeOrder} aria-label="Factory revision comparison">
          <div className={`${styles.plateCap} ${styles.technical}`}>
            <span>Change order / Build prompt</span>
            <span>Factory review</span>
          </div>
          <dl className={styles.patch}>
            <div>
              <dt>
                <span>R07</span> <span>{published ? "Previous" : "Active"}</span>
              </dt>
              <dd>Test the CLI output.</dd>
            </div>
            <div className={styles.patchAdd}>
              <dt>
                <span>R08</span> <span>{published ? "Active" : "Draft"}</span>
              </dt>
              <dd>
                <span aria-hidden="true">+</span> Also test that dry runs never call the deploy API.
              </dd>
            </div>
          </dl>
        </article>
      </div>

      <div className={styles.revisionProof}>
        <div className={styles.revisionCopy}>
          <p className={styles.technical}>Publish gate / Manual path</p>
          <p>
            An owner or admin reviews the saved draft and runs a configuration test before
            publishing. That test checks stage handoffs, not the behavior of the CLI.
          </p>
          <button
            type="button"
            className={`${styles.button} ${styles.ghost}`}
            onClick={() => setStep(next)}
          >
            {action}{" "}
            <span className={styles.arrow} aria-hidden="true">
              {arrow}
            </span>
          </button>
        </div>
        <div className={styles.intakeReceipt} data-revision={step}>
          <p
            className={`${styles.technical} ${styles.revisionStatus}`}
            role="status"
            aria-atomic="true"
          >
            {status}
          </p>
          <div>
            <span>
              Old work order <strong>024</strong>
            </span>
            <b>R07</b>
          </div>
          <div>
            <span>
              Next work order <strong>025</strong>
            </span>
            <b className={styles.nextRevision}>{published ? "R08" : "R07"}</b>
          </div>
          <p>{consequence}</p>
        </div>
      </div>
    </>
  );
}
