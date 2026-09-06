import { notFound } from "next/navigation";

import { UiPrimitivesShowcase } from "@/components/ui/ui-primitives-showcase";
import { isProductionDeploy } from "@/env/deploy";

export default function UiPrimitivesPage() {
  // Preview-reachable: NODE_ENV is always "production" on Vercel.
  if (isProductionDeploy()) notFound();

  return <UiPrimitivesShowcase />;
}
