"use client";

import { useEffect } from "react";

export function BenchmarkMembershipFocus() {
  useEffect(() => {
    if (window.location.hash !== "#suite-membership") return;
    const heading = document.querySelector<HTMLElement>("#suite-membership h2");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, []);
  return null;
}
