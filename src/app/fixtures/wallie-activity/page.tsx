import { notFound } from "next/navigation";

import {
  WallieActivityFixture,
  type WallieActivityFixtureState,
} from "@/features/wallie/wallie-activity-fixture";

function resolveState(value: string | undefined): WallieActivityFixtureState {
  switch (value) {
    case "active":
    case "completed":
    case "disconnected":
    case "empty":
    case "failed":
    case "loading":
    case "queued":
    case "stalled":
      return value;
    default:
      return "active";
  }
}

export default async function WallieActivityFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; theme?: string }>;
}) {
  if (process.env.NODE_ENV !== "development") notFound();

  const { state, theme } = await searchParams;
  const resolvedState = resolveState(state);

  return (
    <WallieActivityFixture
      initialTheme={theme === "dark" ? "dark" : "light"}
      key={`${theme ?? "light"}:${resolvedState}`}
      state={resolvedState}
    />
  );
}
