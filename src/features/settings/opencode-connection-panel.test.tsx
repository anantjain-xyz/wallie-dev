// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenCodeConnectionPanel } from "@/features/settings/opencode-connection-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OpenCodeConnectionPanel", () => {
  it("renders server-loaded connected status without exposing a key", () => {
    render(
      <OpenCodeConnectionPanel
        initialStatus={{
          checkedAt: "2099-08-30T00:00:00.000Z",
          connected: true,
          updatedAt: "2026-08-30T00:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByLabelText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update API key" })).toBeInTheDocument();
    expect(screen.getByLabelText("OpenCode Zen API key")).toHaveValue("");
    expect(screen.getByText("No provider API keys saved yet.")).toBeInTheDocument();
  });

  it("saves a Zen key and reports the updated status", async () => {
    const onStatusChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        checkedAt: "2026-08-30T00:01:00.000Z",
        connected: true,
        updatedAt: "2026-08-30T00:01:00.000Z",
      }),
      ok: true,
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <OpenCodeConnectionPanel
        initialStatus={{ checkedAt: "2099-08-30T00:00:00.000Z", connected: false }}
        onStatusChange={onStatusChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("OpenCode Zen API key"), {
      target: { value: "zen-key-12345678901234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save API key" }));

    await waitFor(() => expect(onStatusChange).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/opencode/connection", {
      body: JSON.stringify({ credential: "zen-key-12345678901234567890" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(screen.getByLabelText("Connected")).toBeInTheDocument();
  });

  it("saves a custom provider key without echoing the secret", async () => {
    const onStatusChange = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/opencode/providers/opencode-go") && init?.method === "PUT") {
        return {
          json: async () => ({
            checkedAt: "2026-09-01T00:01:00.000Z",
            providerId: "opencode-go",
            providers: [{ providerId: "opencode-go", updatedAt: "2026-09-01T00:01:00.000Z" }],
            updatedAt: "2026-09-01T00:01:00.000Z",
          }),
          ok: true,
          status: 200,
        };
      }
      return {
        json: async () => ({
          checkedAt: "2026-09-01T00:01:00.000Z",
          connected: false,
          providers: [{ providerId: "opencode-go", updatedAt: "2026-09-01T00:01:00.000Z" }],
        }),
        ok: true,
        status: 200,
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <OpenCodeConnectionPanel
        initialStatus={{ checkedAt: "2099-08-30T00:00:00.000Z", connected: false, providers: [] }}
        onStatusChange={onStatusChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Provider id"), { target: { value: "opencode-go" } });
    fireEvent.change(screen.getByLabelText("Provider API key"), {
      target: { value: "go-key-12345678901234567890" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save provider key" }));

    await waitFor(() => expect(screen.getByText("opencode-go")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/opencode/providers/opencode-go", {
      body: JSON.stringify({ credential: "go-key-12345678901234567890" }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    expect(screen.queryByDisplayValue("go-key-12345678901234567890")).not.toBeInTheDocument();
    expect(onStatusChange).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [{ providerId: "opencode-go", updatedAt: "2026-09-01T00:01:00.000Z" }],
      }),
    );
  });
});
