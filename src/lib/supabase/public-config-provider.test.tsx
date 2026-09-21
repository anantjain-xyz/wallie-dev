// @vitest-environment jsdom

import { act, useState } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockCreateBrowserClient = vi.hoisted(() => vi.fn(() => ({ client: "browser" })));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: mockCreateBrowserClient,
}));

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { SupabasePublicConfig } from "@/lib/supabase/config";
import {
  SupabasePublicConfigProvider,
  useSupabasePublicConfig,
} from "@/lib/supabase/public-config-provider";

const firstConfig: SupabasePublicConfig = {
  publishableKey: "first-public-key",
  url: "https://first.supabase.co",
};
const secondConfig: SupabasePublicConfig = {
  publishableKey: "second-public-key",
  url: "https://second.supabase.co",
};

function ConfigConsumer() {
  const config = useSupabasePublicConfig();
  return <span>{config?.url ?? "unconfigured"}</span>;
}

function BrowserClientConsumer() {
  const config = useSupabasePublicConfig();
  useState(() => createSupabaseBrowserClient(config));
  return <ConfigConsumer />;
}

describe("SupabasePublicConfigProvider", () => {
  let root: Root | undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps configuration scoped to each server-rendered tree", () => {
    for (const config of [firstConfig, secondConfig, firstConfig]) {
      expect(
        renderToString(
          <SupabasePublicConfigProvider value={config}>
            <BrowserClientConsumer />
          </SupabasePublicConfigProvider>,
        ),
      ).toContain(config.url);
    }

    expect(mockCreateBrowserClient.mock.calls).toEqual([
      [firstConfig.url, firstConfig.publishableKey],
      [secondConfig.url, secondConfig.publishableKey],
      [firstConfig.url, firstConfig.publishableKey],
    ]);
    expect(renderToString(<ConfigConsumer />)).toContain("unconfigured");
  });

  it("allows consumers that do not create a client to render without configuration", () => {
    expect(
      renderToString(
        <SupabasePublicConfigProvider value={firstConfig}>
          <SupabasePublicConfigProvider value={null}>
            <ConfigConsumer />
          </SupabasePublicConfigProvider>
        </SupabasePublicConfigProvider>,
      ),
    ).toContain("unconfigured");
    expect(mockCreateBrowserClient).not.toHaveBeenCalled();
  });

  it("uses the server-provided configuration during hydration", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://build.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "build-public-key");
    const view = (
      <SupabasePublicConfigProvider value={secondConfig}>
        <BrowserClientConsumer />
      </SupabasePublicConfigProvider>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(view);
    document.body.append(container);
    const onRecoverableError = vi.fn();

    await act(async () => {
      root = hydrateRoot(container, view, { onRecoverableError });
    });

    expect(container.textContent).toBe(secondConfig.url);
    expect(mockCreateBrowserClient).toHaveBeenCalledTimes(2);
    expect(mockCreateBrowserClient.mock.calls).toEqual([
      [secondConfig.url, secondConfig.publishableKey],
      [secondConfig.url, secondConfig.publishableKey],
    ]);
    expect(onRecoverableError).not.toHaveBeenCalled();
  });
});
