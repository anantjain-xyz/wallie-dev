// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfigSection } from "@/features/settings/agent-config-section";

const checkedAt = new Date().toISOString();
const initialAgentConfig = {
  agent_model: "gpt-5.5",
  agent_provider: "codex",
  concurrency_limit: 1,
  max_retries: 3,
  stall_timeout_ms: 900_000,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSection(setFlashMessage = vi.fn()) {
  render(
    <AgentConfigSection
      canManage
      initialAgentConfig={initialAgentConfig}
      initialClaudeCodeStatus={{ checkedAt, connected: false }}
      initialCodexStatus={{ checkedAt, connected: false }}
      setFlashMessage={setFlashMessage}
      workspaceId="00000000-0000-4000-8000-000000000001"
    />,
  );
  return setFlashMessage;
}

describe("AgentConfigSection batch save", () => {
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

    expect(screen.getByRole("alert")).toHaveTextContent("Agent model is required.");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
