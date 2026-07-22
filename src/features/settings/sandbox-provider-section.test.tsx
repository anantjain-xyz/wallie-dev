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
    expect(html).not.toContain("Connect E2B");
    expect(html).not.toContain("Connect Daytona");
  });
});
