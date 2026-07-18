import { notFound } from "next/navigation";

import { StatusShowcase } from "@/components/ui/status-showcase";
import { isProductionDeploy } from "@/env/deploy";

export default function StatusesPage() {
  if (isProductionDeploy()) notFound();

  return <StatusShowcase />;
}
