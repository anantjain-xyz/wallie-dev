"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import styles from "./landing.module.css";

const views = [
  { key: "before", label: "Before adoption" },
  { key: "after", label: "After adoption" },
] as const;

type View = (typeof views)[number]["key"];

export function AdoptionReceipt() {
  const [view, setView] = useState<View>("after");
  const buttons = useRef<Partial<Record<View, HTMLButtonElement | null>>>({});
  const adopted = view === "after";
  const nextRevision = adopted ? "R08" : "R07";

  function handleViewKey(event: KeyboardEvent<HTMLButtonElement>, current: View) {
    let next: View;
    switch (event.key) {
      case "Home":
        next = "before";
        break;
      case "End":
        next = "after";
        break;
      case "ArrowLeft":
      case "ArrowRight":
        next = current === "before" ? "after" : "before";
        break;
      default:
        return;
    }
    event.preventDefault();
    setView(next);
    buttons.current[next]?.focus();
  }

  return (
    <div
      className={styles.receipt}
      data-adoption={view}
      role="group"
      aria-label="Admission receipt"
    >
      <p className={`${styles.plateCap} ${styles.technical}`}>
        <span>Admission receipt</span>
        <span>New sessions</span>
      </p>
      <div
        className={styles.receiptControls}
        role="group"
        aria-label="Inspect admission before or after human adoption"
      >
        {views.map(({ key, label }) => (
          <button
            key={key}
            ref={(button) => {
              buttons.current[key] = button;
            }}
            type="button"
            aria-controls="admission-receipt-body"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            onKeyDown={(event) => handleViewKey(event, key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={styles.receiptBody} id="admission-receipt-body">
        <p
          className={`${styles.technical} ${styles.receiptStatus}`}
          role="status"
          aria-atomic="true"
        >
          {adopted
            ? "After a workspace owner or admin adopts"
            : "Before adoption / R07 still active"}
          <span className="sr-only">. Next work order 025 uses {nextRevision}.</span>
        </p>
        <dl>
          <div>
            <dt>
              Already started <strong>WO–024</strong>
            </dt>
            <dd>R07</dd>
          </div>
          <div>
            <dt>
              Next start <strong>WO–025</strong>
            </dt>
            <dd className={styles.nextRevision}>{nextRevision}</dd>
          </div>
        </dl>
        <p className={styles.smallNote}>
          {adopted
            ? "New jobs can start on R08. The existing job keeps the revision it started on."
            : "R08 is still a candidate. Both the existing job and a new start use R07."}
        </p>
      </div>
    </div>
  );
}
