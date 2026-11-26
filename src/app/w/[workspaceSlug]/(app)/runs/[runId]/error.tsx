"use client";

import { RunInspectorFailure } from "@/features/wallie/run-inspector-failure";

export default function RunError({ retry, reset }: { retry?: () => void; reset?: () => void }) {
  return <RunInspectorFailure reset={retry ?? reset} />;
}
