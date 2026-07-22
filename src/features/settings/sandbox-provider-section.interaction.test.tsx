// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SandboxProviderSection } from "@/features/settings/sandbox-provider-section";

afterEach(cleanup);

describe("SandboxProviderSection onboarding flow", () => {
  it("reveals only the selected provider form", async () => {
    const user = userEvent.setup();

    render(
      <SandboxProviderSection
        canManage
        onSettingsChange={vi.fn()}
        setFlashMessage={vi.fn()}
        settings={{
          activeProvider: "vercel",
          connections: { daytona: null, e2b: null, vercel: null },
          enabledProviders: ["vercel", "e2b", "daytona"],
          revision: 1,
          updatedAt: null,
        }}
        variant="onboarding"
        vercelConnection={null}
        workspaceId="00000000-0000-4000-8000-000000000001"
      />,
    );

    expect(
      screen.getByText("Select a provider to continue with its connection details."),
    ).toBeVisible();
    expect(screen.getByText("Active")).toBeVisible();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect E2B" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /E2B/ }));

    expect(screen.getByRole("heading", { name: "Configure E2B" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Connect E2B" })).toBeVisible();
    expect(screen.getByLabelText("API key")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Connect Vercel Sandbox" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect Daytona" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /Daytona/ }));

    expect(screen.getByRole("heading", { name: "Connect Daytona" })).toBeVisible();
    expect(screen.getByLabelText("API URL (optional)")).toBeVisible();
    expect(screen.getByLabelText("Target (optional)")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Connect E2B" })).not.toBeInTheDocument();
  });
});

describe("SandboxProviderSection settings flow", () => {
  it("defaults to the active provider and reveals only the selected provider form", async () => {
    const user = userEvent.setup();

    render(
      <SandboxProviderSection
        canManage
        onSettingsChange={vi.fn()}
        setFlashMessage={vi.fn()}
        settings={{
          activeProvider: "vercel",
          connections: { daytona: null, e2b: null, vercel: null },
          enabledProviders: ["vercel", "e2b", "daytona"],
          revision: 1,
          updatedAt: null,
        }}
        vercelConnection={null}
        workspaceId="00000000-0000-4000-8000-000000000001"
      />,
    );

    expect(screen.getByRole("radio", { name: /Vercel Sandbox/ })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Connect Vercel Sandbox" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Connect E2B" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect Daytona" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /E2B/ }));

    expect(screen.getByRole("heading", { name: "Connect E2B" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Connect Vercel Sandbox" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect Daytona" })).not.toBeInTheDocument();
  });
});
