import { notFound } from "next/navigation";

import { isProductionDeploy } from "@/env/deploy";

// Evaluate the guard at runtime, including when a preview build is promoted.
export const dynamic = "force-dynamic";

export default function DevLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  if (isProductionDeploy()) notFound();

  return children;
}
