import { expect, it, vi } from "vitest";

import { drainFactoryWorkflowRepositoryDeliveries } from "./repository-delivery";

it("runs the publication pass when secondary validation dispatch fails", async () => {
  const dispatchFailure = new Error("Secondary validation queue unavailable");
  const scope = {
    root_session_id: "root",
    workspace_id: "workspace",
    factory_id: "factory",
    generation: 1,
    ownership_token: "owner",
    join_id: "join",
    repository_id: "repository",
  };
  const rpc = vi.fn((name: string) => ({
    abortSignal: async () => {
      if (name === "dispatch_next_factory_workflow_repository_validation") {
        return { data: null, error: dispatchFailure };
      }
      if (name === "list_factory_workflow_repository_deliveries") {
        return { data: [scope], error: null };
      }
      if (name === "claim_factory_workflow_repository_delivery") {
        return { data: null, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  }));

  await expect(drainFactoryWorkflowRepositoryDeliveries({ rpc } as never)).rejects.toBe(
    dispatchFailure,
  );
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    "dispatch_next_factory_workflow_repository_validation",
    "list_factory_workflow_repository_deliveries",
    "claim_factory_workflow_repository_delivery",
  ]);
});
