"use client";

import { useLayoutEffect, useRef } from "react";
import { enterContent } from "@/components/ui/motion";

/** Reveal a semantic change without remounting content or replaying on refresh. */
export function useChangeMotion<T extends HTMLElement>(identity: string | null) {
  const ref = useRef<T>(null);
  const previous = useRef(identity);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = identity;
    // A null identity is an unresolved initial snapshot, not a visible state transition.
    if (before === identity || before === null || identity === null) return;
    const element = ref.current;
    if (!element) return;
    const animation = enterContent(element);
    return () => animation?.cancel();
  }, [identity]);
  return ref;
}
