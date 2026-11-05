"use client";

import type { ComponentProps } from "react";

/** Native navigation handles new fragments. Repeated activation must reopen
 * the same exact run even when the reviewer collapsed it after navigating.
 */
export function RunActivityLink({
  runId,
  ...props
}: Omit<ComponentProps<"a">, "href" | "onClick"> & { runId: string }) {
  const hash = `#wallie-run-${runId}`;
  return (
    <a
      {...props}
      href={hash}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        if (window.location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
      }}
    />
  );
}
