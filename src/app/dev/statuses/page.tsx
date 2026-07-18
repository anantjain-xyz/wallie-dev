import { notFound } from "next/navigation";

import { StatusShowcase } from "@/components/ui/status-showcase";
import { isStatusSimulation } from "@/components/ui/status-showcase-config";
import { isProductionDeploy } from "@/env/deploy";

type StatusesPageProps = {
  searchParams: Promise<{
    display?: string;
    simulation?: string;
    theme?: string;
    zoom?: string;
  }>;
};

export default async function StatusesPage({ searchParams }: StatusesPageProps) {
  if (isProductionDeploy()) notFound();

  const params = await searchParams;

  return (
    <StatusShowcase
      displayMode={params.display === "mobile" ? "mobile" : "desktop"}
      initialSimulation={isStatusSimulation(params.simulation) ? params.simulation : "standard"}
      initialTheme={params.theme === "dark" ? "dark" : "light"}
      initialZoomed={params.zoom === "200"}
    />
  );
}
