import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { AppShell } from "@/components/app-shell/app-shell";

describe("AppShell", () => {
  it("pins the workspace shell to the viewport so nested page anchors cannot scroll the document", () => {
    const element = AppShell({
      children: "Settings",
      onboarding: null,
      viewerEmail: "owner@example.com",
      viewerId: "user-1",
      workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
      workspaceAvatarUrl: null,
    }) as ReactElement<{ className: string }>;

    expect(element.props.className.split(/\s+/u)).toEqual(
      expect.arrayContaining(["fixed", "inset-x-0", "top-0", "h-[100dvh]", "overflow-hidden"]),
    );
  });
});
