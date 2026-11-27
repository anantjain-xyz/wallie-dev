// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ServiceCredentialsPanel } from "@/features/factory-definition/service-credentials-panel";

const id = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ["Open workspace secrets", false],
  ["Rotate in workspace secrets", true],
] as const)("points %s at the canonical Settings section", async (name, ready) => {
  const response = {
    binding: ready
      ? {
          id,
          version: 1,
          status: "ready",
          materialRevision: null,
          rotatedAt: null,
          secretKey: null,
        }
      : null,
    availableBinding: null,
    grantMatches: true,
    eligibleSecrets: [],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(response)),
  );

  render(
    <ServiceCredentialsPanel
      canUseBinding={false}
      endpoint="/api/fixture/secret-bindings"
      onUseBinding={vi.fn()}
      scope={{ agentId: id, grantId: id, grantVersion: 1, provider: "codex" }}
      workspaceSlug="northwind"
    />,
  );

  await screen.findByText(ready ? "Ready to use" : "No service credential attached");
  expect(screen.getByRole("link", { name })).toHaveAttribute(
    "href",
    "/w/northwind/settings#workspace-secrets",
  );
});
