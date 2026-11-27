// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceOnboardingForm } from "./workspace-onboarding-form";

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspace address", () => {
  it("previews the derived route and leaves allocation and collision handling to the server", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ redirectTo: "/w/northwind-studio-1/onboarding" }, { status: 201 }),
    );
    render(<WorkspaceOnboardingForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), {
      target: { value: "Northwind Studio!" },
    });
    expect(screen.getByText("/w/northwind-studio")).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit address" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("textbox", { name: "Custom address" })).not.toBeInTheDocument();

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create workspace" })),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Northwind Studio!", slug: "" }),
      }),
    );
    expect(router.replace).toHaveBeenCalledWith("/w/northwind-studio-1/onboarding");
  });

  it("focuses address errors, keeps a rejected custom address, and lets the user reset it", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: "Wallie could not create that workspace right now." },
        { status: 500 },
      ),
    );
    render(<WorkspaceOnboardingForm />);
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(name, { target: { value: "Northwind Studio" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit address" }));

    const slug = screen.getByRole("textbox", { name: "Custom address" });
    expect(slug).toHaveFocus();
    fireEvent.change(slug, { target: { value: "Wrong Address" } });
    const submit = screen.getByRole("button", { name: "Create workspace" });
    fireEvent.click(submit);
    expect(slug).toHaveFocus();
    expect(slug).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Use lowercase letters");
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(slug, { target: { value: "studio-team" } });
    expect(screen.getByText("/w/studio-team")).toBeVisible();
    await act(async () => fireEvent.click(submit));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces",
      expect.objectContaining({
        body: JSON.stringify({ name: "Northwind Studio", slug: "studio-team" }),
      }),
    );
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(name).toHaveValue("Northwind Studio");
    expect(slug).toHaveValue("studio-team");
    expect(submit).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Use suggested address" }));
    expect(screen.queryByRole("textbox", { name: "Custom address" })).not.toBeInTheDocument();
    expect(screen.getByText("/w/northwind-studio")).toBeVisible();
  });
});
