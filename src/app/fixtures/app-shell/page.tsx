import { notFound } from "next/navigation";

import { AppShellFixture } from "@/components/app-shell/app-shell-fixture";

export default async function AppShellFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string; theme?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { section, theme } = await searchParams;
  const normalizedSection =
    section === "sessions" || section === "settings" || section === "pipeline"
      ? section
      : "pipeline";

  return (
    <AppShellFixture
      initialTheme={theme === "dark" ? "dark" : "light"}
      key={`${theme ?? "light"}:${normalizedSection}`}
      section={normalizedSection}
    />
  );
}
