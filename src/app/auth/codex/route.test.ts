import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  resolveAuthenticatedSettingsPath: vi.fn(),
  startCodexDeviceAuthFlow: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    resolveAuthenticatedSettingsPath: mocked.resolveAuthenticatedSettingsPath,
  };
});

vi.mock("@/lib/codex/device-auth", () => ({
  startCodexDeviceAuthFlow: mocked.startCodexDeviceAuthFlow,
}));

import { GET } from "@/app/auth/codex/route";

describe("GET /auth/codex", () => {
  beforeEach(() => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-123" });
    mocked.resolveAuthenticatedSettingsPath.mockResolvedValue("/settings/integrations");
    mocked.startCodexDeviceAuthFlow.mockResolvedValue({
      error: null,
      expiresAt: "2026-05-19T00:10:00.000Z",
      flowId: "flow-1",
      instructions: "Open https://chatgpt.com/activate and enter ABCD-EFGH",
      status: "prompted",
      userCode: "ABCD-EFGH",
      verificationUri: "https://chatgpt.com/activate",
    });
  });

  afterEach(() => {
    mocked.createSupabaseServerClient.mockReset();
    mocked.getSupabaseUserOrNull.mockReset();
    mocked.resolveAuthenticatedSettingsPath.mockReset();
  });

  it("redirects direct authenticated navigation back to settings with a device-flow flash", async () => {
    const response = await GET(new NextRequest("https://wallie.dev/auth/codex"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://wallie.dev/settings/integrations?codex_connect=chatgpt_device_required",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(mocked.startCodexDeviceAuthFlow).not.toHaveBeenCalled();
  });

  it("starts a device-code flow for authenticated JSON requests", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3000/auth/codex?next=/w/acme/onboarding?step=runtime", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      flowId: "flow-1",
      status: "prompted",
      userCode: "ABCD-EFGH",
    });
    expect(mocked.startCodexDeviceAuthFlow).toHaveBeenCalledWith({ userId: "user-123" });
  });

  it("sends unauthenticated users through login", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost:3000/auth/codex?next=/settings"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("returns 401 for unauthenticated JSON requests", async () => {
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await GET(
      new NextRequest("http://localhost:3000/auth/codex?next=/settings", {
        headers: { accept: "application/json" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
