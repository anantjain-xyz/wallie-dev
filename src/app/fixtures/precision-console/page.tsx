import { notFound } from "next/navigation";

import { PrecisionConsoleFixture } from "@/components/ui/precision-console-fixture";

export default async function PrecisionConsolePage({
  searchParams,
}: {
  searchParams: Promise<{ theme?: string; viewport?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { theme, viewport } = await searchParams;
  return (
    <PrecisionConsoleFixture
      displayMode={viewport === "mobile" ? "mobile" : "desktop"}
      initialTheme={theme === "dark" ? "dark" : "light"}
      key={`${theme ?? "light"}:${viewport ?? "desktop"}`}
    />
  );
}
