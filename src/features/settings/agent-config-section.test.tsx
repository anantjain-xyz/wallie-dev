// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { AgentConfigSection } from "@/features/settings/agent-config-section";

const checkedAt = new Date().toISOString();
const initialAgentConfig = {
  agent_effort: "xhigh",
  agent_model: "gpt-5.5",
  agent_provider: "codex",
  concurrency_limit: 1,
  max_retries: 3,
  stall_timeout_ms: 900_000,
};

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
});

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection(
  setFlashMessage = vi.fn(),
  withOverlays = false,
  agentConfig: Record<string, unknown> = initialAgentConfig,
) {
  const section = (
    <AgentConfigSection
      canManage
      initialAgentConfig={agentConfig as typeof initialAgentConfig}
      initialClaudeCodeStatus={{ checkedAt, connected: false }}
      initialCodexStatus={{ checkedAt, connected: false }}
      setFlashMessage={setFlashMessage}
      workspaceId="00000000-0000-4000-8000-000000000001"
    />
  );
  render(withOverlays ? <OverlayProvider>{section}</OverlayProvider> : section);
  return setFlashMessage;
}

describe("AgentConfigSection batch save", () => {
  it("saves a selected agent effort", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
      void input;
      void request;
      return Promise.resolve({
        json: () => Promise.resolve({ entries: [{ key: "agent_effort", value: "max" }] }),
        ok: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection(vi.fn(), true);

    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    await user.click(screen.getByRole("option", { name: "Max" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body))).toEqual({
      config: { agent_effort: "max" },
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("saves multiple changed fields with one network mutation", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
      void input;
      void request;
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            entries: [
              { key: "agent_model", value: "gpt-5.6" },
              { key: "max_retries", value: 4 },
            ],
          }),
        ok: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    const modelInput = screen.getByDisplayValue("gpt-5.5");
    const retriesInput = screen.getByDisplayValue("3");
    await user.clear(modelInput);
    await user.type(modelInput, "gpt-5.6");
    await user.clear(retriesInput);
    await user.type(retriesInput, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body))).toEqual({
      config: { agent_model: "gpt-5.6", max_retries: 4 },
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("renders field-level errors from the atomic response", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
      void input;
      void request;
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            error: "Agent configuration contains invalid fields.",
            fieldErrors: { agent_model: "The selected model is unavailable." },
          }),
        ok: false,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const setFlashMessage = renderSection();

    const modelInput = screen.getByDisplayValue("gpt-5.5");
    await user.clear(modelInput);
    await user.type(modelInput, "gpt-5.6");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The selected model is unavailable.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setFlashMessage).toHaveBeenCalledWith({
      kind: "error",
      text: "Agent configuration contains invalid fields.",
    });
  });

  it("blocks the entire batch when a dirty field is cleared", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSection();

    await user.clear(screen.getByDisplayValue("gpt-5.5"));
    const retriesInput = screen.getByDisplayValue("3");
    await user.clear(retriesInput);
    await user.type(retriesInput, "4");

    expect(screen.getByRole("alert")).toHaveTextContent("Model is required.");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AgentConfigSection provider options and copy", () => {
  it("renders Provider, Model, and Effort with the contracted help copy", () => {
    renderSection();

    expect(screen.getByRole("combobox", { name: "Provider" })).toBeInTheDocument();
    expect(screen.getByText("Choose the coding agent Wallie uses for runs.")).toBeInTheDocument();
    expect(
      screen.getByText("Model identifier passed to the selected provider."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Reasoning effort passed to the selected provider."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Agent provider")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent model")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent effort")).not.toBeInTheDocument();
    expect(screen.queryByText(/agent CLI/i)).not.toBeInTheDocument();
  });

  it("offers Codex, Claude Code, and Cursor in the Provider select", async () => {
    const user = userEvent.setup();
    renderSection(vi.fn(), true);

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Codex", "Claude Code", "Cursor"]);
    expect(screen.queryByRole("option", { name: "Not configured" })).not.toBeInTheDocument();
  });

  it("hides unsupported effort configuration for Cursor", () => {
    renderSection(vi.fn(), false, {
      ...initialAgentConfig,
      agent_model: "auto",
      agent_provider: "cursor",
    });

    expect(screen.queryByRole("combobox", { name: "Effort" })).not.toBeInTheDocument();
    expect(screen.queryByText("Reasoning effort passed to the selected provider.")).toBeNull();
  });
});

describe("AgentConfigSection missing provider fallback", () => {
  it("displays Codex for a missing provider without writing or marking dirty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSection(vi.fn(), false, { ...initialAgentConfig, agent_provider: undefined });

    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("Codex");
    expect(screen.getByText("No unsaved changes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("displays Codex for a legacy-empty provider without writing or marking dirty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSection(vi.fn(), false, { ...initialAgentConfig, agent_provider: "" });

    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent("Codex");
    expect(screen.getByText("No unsaved changes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists Codex on the next explicit save when the stored provider is empty", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
      void input;
      void request;
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            entries: [
              { key: "agent_provider", value: "codex" },
              { key: "max_retries", value: 4 },
            ],
          }),
        ok: true,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSection(vi.fn(), false, { ...initialAgentConfig, agent_provider: "" });

    const retriesInput = screen.getByDisplayValue("3");
    await user.clear(retriesInput);
    await user.type(retriesInput, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(request?.body))).toEqual({
      config: { agent_provider: "codex", max_retries: 4 },
      workspaceId: "00000000-0000-4000-8000-000000000001",
    });
  });
});
