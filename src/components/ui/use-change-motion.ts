"use client";

import { useEffect, useRef } from "react";
import { enterContent } from "@/components/ui/motion";

/** Reveal a semantic change without remounting content or replaying on refresh. */
export function useChangeMotion<T extends HTMLElement>(identity: string) {
  const ref = useRef<T>(null);
  const previous = useRef(identity);
  useEffect(() => {
    if (previous.current === identity) return;
    previous.current = identity;
    const element = ref.current;
    if (!element) return;
    const animation = enterContent(element);
    return () => animation?.cancel();
  }, [identity]);
  return ref;
}
