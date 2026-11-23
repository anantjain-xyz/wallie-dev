import { afterEach, expect, it, vi } from "vitest";

import { drainFactoryWorkflowSandboxStops } from "./sandbox-stop-drain";

const { stopRunSandbox } = vi.hoisted(() => ({ stopRunSandbox: vi.fn() }));
vi.mock("@/lib/pipeline/cancel", () => ({ stopRunSandbox }));

const sandbox = {
  run_id: "old-run",
  sandbox_id: "provider-sandbox",
  sandbox_connection_revision: "exact-revision",
  sandbox_provider: "vercel",
  sandbox_vercel_project_id: "original-project",
  sandbox_vercel_team_id: "original-team",
  workspace_id: "workspace",
};

const stop = { ...sandbox, obligation_id: "obligation", lease_token: "lease" };

function adminWithClaims(claims: (typeof stop)[], settle = { data: true, error: null }) {
  const rpc = vi.fn(async (name: string) =>
    name === "claim_factory_workflow_sandbox_stops" ? { data: claims, error: null } : settle,
  );
  return {
    rpc,
    admin: { rpc } as unknown as Parameters<typeof drainFactoryWorkflowSandboxStops>[0],
  };
}

afterEach(() => stopRunSandbox.mockReset());

it("confirms only the leased, exact provider stop", async () => {
  stopRunSandbox.mockResolvedValueOnce(true);
  const { admin, rpc } = adminWithClaims([stop]);
  expect(await drainFactoryWorkflowSandboxStops(admin)).toEqual({
    claimed: 1,
    confirmed: 1,
    pending: 0,
  });
  const { run_id: id, ...expected } = sandbox;
  expect(stopRunSandbox).toHaveBeenCalledWith(admin, { id, ...expected }, undefined, {
    throwOnError: true,
  });
  expect(rpc).toHaveBeenLastCalledWith("settle_factory_workflow_sandbox_stop", {
    p_obligation_id: stop.obligation_id,
    p_lease_token: stop.lease_token,
    p_confirmed: true,
  });
});

it("keeps a provider failure pending and still completes another claimed row", async () => {
  stopRunSandbox.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(true);
  const next = { ...stop, obligation_id: "other-obligation", lease_token: "other-lease" };
  const { admin, rpc } = adminWithClaims([stop, next]);
  expect(await drainFactoryWorkflowSandboxStops(admin)).toEqual({
    claimed: 2,
    confirmed: 1,
    pending: 1,
  });
  expect(rpc).toHaveBeenCalledWith("settle_factory_workflow_sandbox_stop", {
    p_obligation_id: stop.obligation_id,
    p_lease_token: stop.lease_token,
    p_confirmed: false,
  });
  expect(rpc).toHaveBeenCalledWith("settle_factory_workflow_sandbox_stop", {
    p_obligation_id: next.obligation_id,
    p_lease_token: next.lease_token,
    p_confirmed: true,
  });
});

it("does not report confirmation if the stop succeeded after the lease was lost", async () => {
  stopRunSandbox.mockResolvedValueOnce(true);
  const { admin } = adminWithClaims([stop], { data: false, error: null });
  expect(await drainFactoryWorkflowSandboxStops(admin)).toEqual({
    claimed: 1,
    confirmed: 0,
    pending: 1,
  });
});
