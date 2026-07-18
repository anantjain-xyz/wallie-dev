import { notFound } from "next/navigation";

import { UiPrimitivesShowcase } from "@/components/ui/ui-primitives-showcase";

export default function UiPrimitivesPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  return <UiPrimitivesShowcase />;
}
