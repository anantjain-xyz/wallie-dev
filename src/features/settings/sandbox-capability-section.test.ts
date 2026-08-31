import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import { dateFormatter } from "@/features/settings/settings-ui";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";

function renderSection(check: SandboxCapabilityCheckState) {
  return renderToStaticMarkup(
    createElement(SandboxCapabilitySection, {
      canManage: true,
      initialCheck: check,
      repositories: [],
      sandboxConnected: true,
      setFlashMessage: () => {},
      workspaceId: "00000000-0000-4000-8000-000000000001",
    }),
  );
}

const baseCheck: SandboxCapabilityCheckState = {
  capabilities: {},
  checkedAt: "2026-05-16T18:00:00.000Z",
  errorText: null,
  githubRepositoryId: "11111111-1111-4111-8111-111111111111",
  id: "check-1",
  sandboxProvider: "vercel",
  sandboxVercelProjectId: "prj_123",
  sandboxVercelTeamId: "team_123",
  status: "success",
};

describe("SandboxCapabilitySection capability tiles", () => {
  it("uses sandbox-neutral guidance when no provider is connected", () => {
    const markup = renderToStaticMarkup(
      createElement(SandboxCapabilitySection, {
        canManage: true,
        initialCheck: null,
        repositories: [],
        sandboxConnected: false,
        setFlashMessage: () => {},
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(markup).toContain("Connect a sandbox provider before running a capability check.");
    expect(markup).not.toContain("Connect Vercel Sandbox before running a capability check.");
  });

  it("renders missing-detail capabilities neutral, not as failures", () => {
    const markup = renderSection({
      ...baseCheck,
      capabilities: {
        git: { detail: null, ok: false },
      },
    });

    // The missing-detail tile must not be styled as a danger/failure tile.
    expect(markup).toContain("No detail recorded.");
    expect(markup).toContain("bg-control-muted");
    expect(markup).not.toContain("bg-danger-soft");
  });

  it("still renders recorded failures (detail + ok:false) as danger", () => {
    const markup = renderSection({
      ...baseCheck,
      status: "error",
      capabilities: {
        node: { detail: "node: command not found", ok: false },
      },
    });

    expect(markup).toContain("node: command not found");
    expect(markup).toContain("bg-danger-soft");
  });

  it("formats the check timestamp with the shared settings dateFormatter", () => {
    const markup = renderSection(baseCheck);

    expect(markup).toContain(dateFormatter.format(new Date(baseCheck.checkedAt)));
  });
});
