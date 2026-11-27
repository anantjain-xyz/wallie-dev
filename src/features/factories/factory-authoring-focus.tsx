"use client";

import { useEffect } from "react";

export function FactoryAuthoringFocus({ target }: { target: string }) {
  useEffect(() => {
    if (window.location.hash === `#${target}`) {
      document.getElementById(target)?.focus({ preventScroll: true });
    }
  }, [target]);

  return null;
}
