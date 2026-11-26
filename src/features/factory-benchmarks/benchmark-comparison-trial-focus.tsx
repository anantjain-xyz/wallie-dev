"use client";

import { useEffect } from "react";

const trialFragment = /^#(trial-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i;

export function BenchmarkComparisonTrialFocus({ pageKey }: { pageKey: string }) {
  useEffect(() => {
    function restoreFocus() {
      const match = trialFragment.exec(window.location.hash);
      if (!match) return;

      const section = document.getElementById("comparison-trials");
      if (!section) return;
      const rowLink = document.getElementById(match[1].toLowerCase());
      const target =
        rowLink instanceof HTMLAnchorElement && section.contains(rowLink) ? rowLink : section;
      if (target === section) section.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: "start" });
    }

    restoreFocus();
    window.addEventListener("hashchange", restoreFocus);
    return () => window.removeEventListener("hashchange", restoreFocus);
  }, [pageKey]);
  return null;
}
