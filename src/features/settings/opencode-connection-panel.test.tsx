// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenCodeConnectionPanel } from "@/features/settings/opencode-connection-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OpenCodeConnectionPanel", () => {
  it("prefills the selected model's custom provider prefix without locking manual entry", () => {
    const { rerender } = render(
      <OpenCodeConnectionPanel
        initialStatus={{ checkedAt: "2099-08-30T00:00:00.000Z", connected: false }}
        selectedModel="openrouter/anthropic/claude-sonnet-4"
      />,
    );
    const provider = screen.getByLabelText("Provider id");
    expect(provider).toHaveValue("openrouter");
    fireEvent.change(provider, { target: { value: "my-custom-provider" } });
    rerender(<OpenCodeConnectionPanel selectedModel="opencode-go/glm-5.3" />);
    expect(provider).toHaveValue("my-custom-provider");
  });

  it("clears draft credentials when the model or manual override changes the provider", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const status = { checkedAt: "2099-08-30T00:00:00.000Z", connected: false };
    const { rerender } = render(
      <OpenCodeConnectionPanel initialStatus={status} selectedModel="openrouter/model-a" />,
    );
    const provider = screen.getByLabelText("Provider id");
    const key = screen.getByLabelText("Provider API key");
    const save = screen.getByRole("button", { name: "Save provider key" });
    fireEvent.change(key, { target: { value: "example-openrouter-key" } });
    rerender(<OpenCodeConnectionPanel initialStatus={status} selectedModel="openrouter/model-b" />);
    expect(key).toHaveValue("example-openrouter-key");
    expect(save).toBeEnabled();

    rerender(
      <OpenCodeConnectionPanel initialStatus={status} selectedModel="opencode-go/glm-5.3" />,
    );
    expect(provider).toHaveValue("opencode-go");
    expect(key).toHaveValue("");
    expect(save).toBeDisabled();
    fireEvent.submit(key.closest("form")!);

    fireEvent.change(key, { target: { value: "example-go-key" } });
    fireEvent.change(provider, { target: { value: "openrouter" } });
    expect(key).toHaveValue("");
    expect(save).toBeDisabled();
    fireEvent.submit(key.closest("form")!);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers named alternatives to the model default and clears the key when one is picked", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    const onDraftStateChange = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <OpenCodeConnectionPanel
        initialStatus={{ checkedAt: "2099-08-30T00:00:00.000Z", connected: false }}
        onDraftStateChange={onDraftStateChange}
        selectedModel="openrouter/model"
      />,
    );
    const provider = screen.getByRole("combobox", { name: "Provider id" });
    const key = screen.getByLabelText("Provider API key");

    await user.click(provider);
    const modelOption = screen.getByRole("option", { name: "OpenRouter · openrouter" });
    expect(modelOption).toHaveAttribute("aria-selected", "true");
    await user.click(modelOption);
    expect(provider).toHaveValue("openrouter");
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, pending: false });

    await user.type(key, "example-openrouter-key");
    await user.click(provider);
    await user.keyboard("{ArrowDown}{Escape}");
    expect(provider).toHaveFocus();
    expect(provider).toHaveValue("openrouter");
    expect(key).toHaveValue("example-openrouter-key");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(provider).toHaveValue("anthropic");
    expect(provider).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(key).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save provider key" })).toBeDisabled();
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, pending: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters suggestions by name and saves unlisted text using only its trimmed id in the URL", async () => {
    const user = userEvent.setup();
    const status = { checkedAt: "2099-08-30T00:00:00.000Z", connected: false };
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => status, ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<OpenCodeConnectionPanel initialStatus={status} selectedModel="opencode/model" />);
    const provider = screen.getByRole("combobox", { name: "Provider id" });
    const key = screen.getByLabelText("Provider API key");
    const credential = "synthetic-provider-test-key";

    expect(provider).toHaveValue("");
    await user.type(provider, "CODE GO");
    expect(screen.getByRole("listbox", { name: "Provider suggestions" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toEqual([
      screen.getByRole("option", { name: "OpenCode Go · opencode-go" }),
    ]);

    await user.clear(provider);
    await user.type(provider, "fixture.proxy_v2");
    await user.type(key, credential);
    await user.click(provider);
    fireEvent.change(provider, { target: { value: "  fixture.proxy_v2  " } });
    expect(key).toHaveValue(credential);
    expect(provider).toHaveValue("  fixture.proxy_v2  ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(key).toHaveValue(""));
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/opencode/providers/fixture.proxy_v2", {
      body: JSON.stringify({ credential }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    expect(provider).toHaveValue("");
  });

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
    const user = userEvent.setup();
    const onDraftStateChange = vi.fn();
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
        onDraftStateChange={onDraftStateChange}
        onStatusChange={onStatusChange}
      />,
    );

    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, pending: false });
    await user.click(screen.getByRole("combobox", { name: "Provider id" }));
    await user.click(screen.getByRole("option", { name: "OpenCode Go · opencode-go" }));
    await user.type(screen.getByLabelText("Provider API key"), "go-key-12345678901234567890");
    expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: true, pending: false });
    await user.click(screen.getByRole("button", { name: "Save provider key" }));

    await waitFor(() =>
      expect(onDraftStateChange).toHaveBeenLastCalledWith({ dirty: false, pending: false }),
    );
    expect(onDraftStateChange).toHaveBeenCalledWith({ dirty: true, pending: true });
    expect(screen.getByText("opencode-go")).toBeInTheDocument();
    expect(screen.getByText("OpenCode Go")).toBeInTheDocument();
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
