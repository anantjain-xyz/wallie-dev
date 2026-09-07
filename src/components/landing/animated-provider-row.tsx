"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import styles from "./landing.module.css";

export function AnimatedProviderRow({
  choices,
  intervalMs,
  label,
  className,
}: {
  choices: { id: string; label: string; logo: ReactNode }[];
  intervalMs: number;
  label: string;
  className: string;
}) {
  const rowRef = useRef<HTMLUListElement>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const count = choices.length;

  useEffect(() => {
    if (count < 2) return;

    const timer = window.setInterval(() => {
      const row = rowRef.current;
      if (
        !row ||
        document.hidden ||
        row.closest("figure")?.dataset.animation !== "playing" ||
        getComputedStyle(row).getPropertyValue("--provider-motion").trim() === "paused"
      ) {
        return;
      }

      // Choose any other provider, so every tick visibly changes the combination.
      const offset = 1 + Math.floor(Math.random() * (count - 1));
      setHighlightedIndex((current) => (current + offset) % count);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [count, intervalMs]);

  return (
    <ul ref={rowRef} className={className} aria-label={label}>
      {choices.map(({ id, label: providerLabel, logo }, index) => (
        <li
          key={id}
          className={styles.providerOption}
          data-highlighted={index === highlightedIndex}
        >
          <span className={styles.providerLogo}>{logo}</span>
          <span className={styles.providerLabel}>{providerLabel}</span>
        </li>
      ))}
    </ul>
  );
}
