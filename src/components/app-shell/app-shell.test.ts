import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { AppShell } from "@/components/app-shell/app-shell";

describe("AppShell", () => {
  it("lets the document scroll while the workspace shell grows to at least the viewport", () => {
    const element = AppShell({
      children: "Settings",
      onboarding: null,
      viewerEmail: "owner@example.com",
      viewerId: "user-1",
      workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
      workspaceAvatarUrl: null,
    }) as ReactElement<{ "data-app-shell"?: string; children: ReactNode; className: string }>;

    const classes = element.props.className.split(/\s+/u);
    expect(classes).toContain("min-h-[100svh]");
    expect(classes).not.toEqual(expect.arrayContaining(["fixed", "h-[100dvh]", "overflow-hidden"]));
    expect(element.props["data-app-shell"]).toBe("");
  });
});
