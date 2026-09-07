import { notFound } from "next/navigation";
import { isProductionDeploy } from "@/env/deploy";
import { SessionsListLoadingSkeleton } from "@/features/sessions/loading-skeletons";

/** Isolated, non-production proof surface for the responsive loading layout. */
export default function LoadingContinuityFixture() {
  if (isProductionDeploy()) notFound();
  return (
    <main id="main-content">
      <SessionsListLoadingSkeleton />
    </main>
  );
}
