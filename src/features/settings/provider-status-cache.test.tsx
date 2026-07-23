// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeCodeConnectionPanel } from "@/features/settings/claude-code-connection-panel";
import { CodexConnectionPanel } from "@/features/settings/codex-connection-panel";
import {
  isProviderStatusStale,
  PROVIDER_STATUS_STALE_AFTER_MS,
} from "@/features/settings/provider-status-cache";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("provider status cache", () => {
  it("treats server status as fresh through 60 seconds and stale after that", () => {
    const checkedAt = "2026-07-18T12:00:00.000Z";
    const checkedAtMs = Date.parse(checkedAt);

    expect(isProviderStatusStale(checkedAt, checkedAtMs + PROVIDER_STATUS_STALE_AFTER_MS)).toBe(
      false,
    );
    expect(isProviderStatusStale(checkedAt, checkedAtMs + PROVIDER_STATUS_STALE_AFTER_MS + 1)).toBe(
      true,
    );
  });

  it("does not duplicate provider status requests when fresh server data is mounted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const checkedAt = new Date().toISOString();

    render(
      <>
        <CodexConnectionPanel initialStatus={{ checkedAt, connected: false }} />
        <ClaudeCodeConnectionPanel initialStatus={{ checkedAt, connected: false }} />
      </>,
    );

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("seeds the reconnect form and status details from fresh server data", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CodexConnectionPanel
        initialStatus={{
          checkedAt: new Date().toISOString(),
          connected: false,
          credentialType: "codex_access_token",
          expired: true,
        }}
      />,
    );

    expect(screen.getByPlaceholderText("Paste access token")).toBeTruthy();
    cleanup();

    render(
      <CodexConnectionPanel
        initialStatus={{
          checkedAt: new Date().toISOString(),
          connected: false,
          credentialType: "chatgpt_auth_json",
          reconnectReason: "Refresh token was rejected.",
          reconnectRequired: true,
        }}
      />,
    );

    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Refresh token was rejected.")).toBeTruthy();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders a cached ChatGPT account without refetching fresh status", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CodexConnectionPanel
        initialStatus={{
          accountEmail: "owner@example.com",
          checkedAt: new Date().toISOString(),
          connected: true,
          credentialType: "chatgpt_auth_json",
        }}
      />,
    );

    expect(screen.getByText("Signed in as owner@example.com")).toBeTruthy();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes a blocked ChatGPT setup prompt through the sandbox step selector", async () => {
    const fetchMock = vi.fn();
    const onSandboxConnectionSelect = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CodexConnectionPanel
        initialStatus={{ checkedAt: new Date().toISOString(), connected: false }}
        onSandboxConnectionSelect={onSandboxConnectionSelect}
        sandboxConnectionHref="#sandbox"
        sandboxConnectionLabel="Vercel Sandbox"
        sandboxConnectionReady={false}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Vercel Sandbox" }));

    expect(onSandboxConnectionSelect).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("background-revalidates stale server status for each mounted provider", async () => {
    const checkedAt = new Date(Date.now() - PROVIDER_STATUS_STALE_AFTER_MS - 1).toISOString();
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        json: () => Promise.resolve({ checkedAt: new Date().toISOString(), connected: false }),
        ok: true,
        url,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <>
        <CodexConnectionPanel initialStatus={{ checkedAt, connected: false }} />
        <ClaudeCodeConnectionPanel initialStatus={{ checkedAt, connected: false }} />
      </>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledWith("/api/codex/connection", { cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledWith("/api/claude-code/connection", {
      cache: "no-store",
    });
  });
});
