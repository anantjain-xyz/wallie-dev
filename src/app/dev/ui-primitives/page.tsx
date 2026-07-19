import { notFound } from "next/navigation";

import { UiPrimitivesShowcase } from "@/components/ui/ui-primitives-showcase";
import { isProductionDeploy } from "@/env/deploy";

export default function UiPrimitivesPage() {
  // Allow under local `pnpm start` / Playwright production builds; block Vercel production.
  if (isProductionDeploy()) notFound();

  return <UiPrimitivesShowcase />;
}
