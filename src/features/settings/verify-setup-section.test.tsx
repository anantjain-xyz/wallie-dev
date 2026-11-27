// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { SettingsPageData } from "./data";
import { VerifySetupSection } from "./verify-setup-section";

const mock = vi.hoisted(() => ({
  useFactory: vi.fn(),
  capability: vi.fn<(props: unknown) => null>(() => null),
}));

vi.mock("./factory-settings", () => ({ useFactorySettings: mock.useFactory }));
vi.mock("./sandbox-capability-section", () => ({ SandboxCapabilitySection: mock.capability }));
vi.mock("@/features/onboarding/runtime-readiness", () => ({
  buildVerifyChecklist: () => [
    {
      id: "github",
      label: "GitHub connected",
      detail: "Connected to fixture-org.",
      passed: true,
      step: "github",
    },
    {
      id: "linear",
      label: "Linear configured",
      detail: "Set an API key.",
      passed: false,
      step: "linear",
    },
    {
      id: "sandbox",
      label: "Sandbox capability check",
      detail: "Workspace check is stale.",
      passed: false,
      step: "verify",
      statusLabel: "Stale",
    },
  ],
}));

const data = {
  canManage: true,
  github: { repositories: [{ id: "repo-a", fullName: "fixture-org/demo" }] },
  setupHealth: {
    primaryRepositoryProfile: { repositoryId: "repo-a" },
    selectedRepository: { repositoryId: "repo-a" },
    latestSandboxCapabilityCheck: null,
    sandboxConnection: { connected: true },
  },
  sandboxSettings: {
    enabledProviders: ["e2b"],
    connections: { e2b: { status: "connected" } },
  },
  workspace: { id: "workspace-a" },
} as unknown as SettingsPageData;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each([
  ["Factory draft capability", "draft"],
  ["Published factory capability", "revision"],
])("keeps workspace readiness separate from %s", (heading, kind) => {
  mock.useFactory.mockReturnValue({
    phase: "ready",
    snapshot: {
      repositoryId: "repo-a",
      sandboxProvider: "e2b",
      ...(kind === "draft" ? { draft: { id: "definition" } } : { published: { id: "definition" } }),
    },
  });
  render(<VerifySetupSection data={data} setData={vi.fn()} setFlashMessage={vi.fn()} />);

  expect(screen.getByRole("heading", { name: "Workspace readiness" })).toBeVisible();
  expect(screen.getByText("Workspace sandbox capability")).toBeVisible();
  expect(screen.getByText("Passing checks (1)")).toBeVisible();
  expect(screen.getByText("GitHub connected")).not.toBeVisible();
  expect(screen.getByText("Stale")).toBeVisible();
  expect(screen.getByRole("heading", { name: heading })).toBeVisible();
  expect(screen.getByText(/fixture-org\/demo · E2B/u)).toBeVisible();
  expect(screen.getByText("Linear API key and session routing")).toBeVisible();
  expect(screen.getByRole("link", { name: "Open Factory connector resources" })).toHaveAttribute(
    "href",
    "#connector-resources",
  );
  expect(mock.capability.mock.calls[0]?.[0]).toMatchObject({
    definitionTarget: { id: "definition", kind, repositoryId: "repo-a" },
    onCheckChange: undefined,
  });
});
