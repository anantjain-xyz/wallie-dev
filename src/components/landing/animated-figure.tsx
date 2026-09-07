"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

import styles from "./landing.module.css";

export function AnimatedFigure({
  caption,
  children,
  className = "",
}: {
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  const captionId = useId();
  const figureRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;

    if (typeof IntersectionObserver === "undefined") {
      figure.dataset.animation = "playing";
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          figure.dataset.animation = "playing";
        } else if (figure.dataset.animation === "playing") {
          figure.dataset.animation = "offscreen";
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(figure);
    return () => observer.disconnect();
  }, []);

  return (
    <figure
      ref={figureRef}
      className={`${styles.animatedFigure} ${className}`}
      aria-labelledby={captionId}
      data-animation="waiting"
    >
      <figcaption id={captionId} className={styles.figureTitle}>
        {caption}
      </figcaption>
      {children}
    </figure>
  );
}
