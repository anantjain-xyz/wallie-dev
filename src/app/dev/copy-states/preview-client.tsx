"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { PageFailure } from "@/components/ui/page-failure";
import { SessionReviewEvidence } from "@/features/sessions/detail/session-review-evidence";

export function CopyStatesPreview({ onboarding }: { onboarding: ReactNode }) {
  const state = useSearchParams().get("state");
  const [recovered, setRecovered] = useState(false);
  if (state?.startsWith("onboarding")) return onboarding;
  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-8">
      {state === "delivery" ? (
        <SessionReviewEvidence
          historical={false}
          initialNow="2026-11-08T12:00:00.000Z"
          sessionId="preview"
        />
      ) : recovered ? (
        <p role="status" tabIndex={-1} ref={(element) => element?.focus()}>
          Page loaded.
        </p>
      ) : (
        <PageFailure reset={() => setRecovered(true)} />
      )}
    </main>
  );
}
