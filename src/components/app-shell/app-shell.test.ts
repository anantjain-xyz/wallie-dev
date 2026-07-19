import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { AppShell } from "@/components/app-shell/app-shell";

const stylesheet = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

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

  it("bounds dialogs and toasts to the visual viewport safe region", () => {
    const dialogRule = stylesheet.match(/\.ui-dialog-content\s*\{([^}]*)\}/u)?.[1];
    const toastRule = stylesheet.match(/\.ui-toast-viewport\s*\{([^}]*)\}/u)?.[1];

    expect(dialogRule).toContain("var(--wallie-visual-viewport-offset-top)");
    expect(dialogRule).toContain("var(--wallie-visual-viewport-bottom-offset)");
    expect(dialogRule).toContain("var(--overlay-gutter-block-start)");
    expect(dialogRule).toContain("var(--overlay-gutter-block-end)");
    expect(toastRule).toContain("var(--wallie-visual-viewport-bottom-offset)");
    expect(toastRule).toContain("var(--overlay-gutter-block-end)");
  });
});
