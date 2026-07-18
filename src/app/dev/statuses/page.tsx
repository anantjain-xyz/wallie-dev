import { notFound } from "next/navigation";

import { StatusShowcase } from "@/components/ui/status-showcase";

export default function StatusesPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return <StatusShowcase />;
}
