"use client";
import { PageFailure } from "@/components/ui/page-failure";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main id="main-content" tabIndex={-1}>
      <PageFailure
        reset={reset}
        returnHref="/recovery"
        returnIsBack={false}
        returnLabel="Get help"
      />
    </main>
  );
}
