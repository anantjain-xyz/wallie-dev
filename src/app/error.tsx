"use client";
import { PageFailure } from "@/components/ui/page-failure";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main-content">
      <PageFailure reset={reset} />
    </main>
  );
}
