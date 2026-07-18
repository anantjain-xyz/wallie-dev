import type { ReactElement } from "react";
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
    }) as ReactElement<{ children: ReactElement; className: string }>;

    const classes = element.props.className.split(/\s+/u);
    expect(classes).toContain("min-h-[100svh]");
    expect(classes).not.toEqual(expect.arrayContaining(["fixed", "h-[100dvh]", "overflow-hidden"]));

    const surface = element.props.children as ReactElement<{ children: ReactElement[] }>;
    const main = surface.props.children[1] as ReactElement<{ className: string; id: string }>;
    expect(main.props.id).toBe("main-content");
    expect(main.props.className.split(/\s+/u)).not.toContain("overflow-y-auto");
  });
});
