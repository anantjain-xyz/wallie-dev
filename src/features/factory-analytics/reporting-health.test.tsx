// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ReportingHealth } from "./reporting-health";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);

it("bounds a failed, scope-specific health read and shows recovery without controls", async () => {
  const abortSignal = vi.fn().mockRejectedValue(new Error("Read timed out"));
  const rpc = vi.fn().mockReturnValue({ abortSignal });
  const body = await ReportingHealth({
    supabase: { rpc } as unknown as Parameters<typeof ReportingHealth>[0]["supabase"],
    workspaceId: "workspace",
    factoryId: "factory",
    captureStartedAt: null,
  });
  const { container } = render(body);
  expect(rpc).toHaveBeenCalledExactlyOnceWith("get_factory_flow_projection_health", {
    p_workspace_id: "workspace",
    p_factory_id: "factory",
  });
  expect(abortSignal).toHaveBeenCalledWith(expect.objectContaining({ aborted: false }));
  expect(screen.getByText("Health unavailable", { exact: true })).toBeVisible();
  container.querySelector("details")!.open = true;
  expect(screen.getByText(/Reload this page to try again/)).toBeVisible();
  expect(screen.queryByRole("button", { name: /projection/u })).not.toBeInTheDocument();
  expect(screen.queryByText("Advanced", { exact: true })).not.toBeInTheDocument();
  expect(screen.queryByText("Projection snapshot", { exact: true })).not.toBeInTheDocument();
});
