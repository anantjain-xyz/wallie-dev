/** Read at the moment of interaction so changing either preference takes effect immediately. */
export function allowsMotion() {
  return (
    document.documentElement.dataset.reducedMotion !== "reduce" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function enterContent(element: HTMLElement) {
  if (typeof element.animate !== "function" || !allowsMotion()) return null;
  return element.animate(
    [
      { opacity: 0.65, transform: "translateY(4px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  );
}
