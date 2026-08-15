import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SandboxProviderSection } from "@/features/settings/sandbox-provider-section";

describe("SandboxProviderSection", () => {
  it("only exposes providers enabled for the deployment", () => {
    const html = renderToStaticMarkup(
      <SandboxProviderSection
        canManage
        onSettingsChange={vi.fn()}
        setFlashMessage={vi.fn()}
        settings={{
          activeProvider: "vercel",
          connections: { daytona: null, e2b: null, vercel: null },
          enabledProviders: ["vercel"],
          revision: 1,
          updatedAt: null,
        }}
        vercelConnection={null}
        workspaceId="00000000-0000-4000-8000-000000000001"
      />,
    );

    expect(html).toContain("Connect Vercel Sandbox");
    expect(html).toContain("Configure Vercel Sandbox");
    expect(html).toContain(">Sandbox<");
    expect(html).not.toContain("Sandbox provider");
    expect(html).not.toContain("Connect E2B");
    expect(html).not.toContain("Connect Daytona");
  });

  it("summarizes a configured connection without secret inputs", () => {
    const html = renderToStaticMarkup(
      <SandboxProviderSection
        canManage
        onSettingsChange={vi.fn()}
        setFlashMessage={vi.fn()}
        settings={{
          activeProvider: "vercel",
          connections: {
            daytona: null,
            e2b: null,
            vercel: {
              connectionRevision: "revision-vercel",
              lastValidatedAt: "2026-07-17T12:00:00.000Z",
              lastValidationError: null,
              projectId: "prj_123",
              projectName: "wallie-sandboxes",
              status: "connected",
              teamId: "team_123",
              tokenPreview: "vca_…1234",
              updatedAt: "2026-07-17T12:00:00.000Z",
              workspaceId: "00000000-0000-4000-8000-000000000001",
            },
          },
          enabledProviders: ["vercel", "e2b", "daytona"],
          revision: 1,
          updatedAt: null,
        }}
        vercelConnection={null}
        workspaceId="00000000-0000-4000-8000-000000000001"
      />,
    );

    expect(html).toContain("Vercel Sandbox connected");
    expect(html).toContain("vca_…1234");
    expect(html).toContain("Team ID");
    expect(html).toContain("team_123");
    expect(html).toContain("Project ID");
    expect(html).toContain("prj_123");
    expect(html).toContain("Replace connection");
    expect(html).toContain("Switch to another connected provider before disconnecting this one.");
    expect(html).not.toContain("Connect Vercel Sandbox");
    expect(html).not.toContain('type="password"');
  });
});
