"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

export function useInsightFilters<T extends Record<string, string>>(
  path: string,
  scope: Record<string, string>,
  applied: T,
) {
  const router = useRouter();
  const [filters, setOptimistic] = useOptimistic(applied);
  const [pending, startTransition] = useTransition();

  function update(next: T) {
    const params = new URLSearchParams(scope);
    for (const [key, value] of Object.entries(next)) {
      if (value) params.set(key, value);
    }
    startTransition(() => {
      setOptimistic(next);
      router.push(`${path}?${params}`, { scroll: false });
    });
  }

  return { filters, pending, update };
}
