import { expect, it } from "vitest";

import { compileFactoryDefinition } from "./compiler";

it("keeps the native serial parity fixture bound to the production compiler", async () => {
  const id = (slot: number) => `65700000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
  const workspaceId = id(11);
  const result = compileFactoryDefinition(
    {
      kind: "structured",
      value: {
        schemaVersion: 1,
        kind: "serial",
        pipeline: id(31),
        repository: id(35),
        sandboxProvider: "e2b",
        agent: {
          provider: "codex",
          model: "gpt-5.5",
          effort: "high",
          concurrencyLimit: 1,
          stallTimeoutMs: 900_000,
          maxRetries: 3,
          maxTurns: 5,
        },
        stages: [
          {
            id: id(32),
            slug: "plan",
            name: "Plan",
            approverMemberIds: [id(22)],
            promptTemplateMd: "Plan {{session.prompt}}.",
          },
          {
            id: id(33),
            slug: "build",
            name: "Build",
            approverMemberIds: [id(22)],
            promptTemplateMd: "Build from {{artifact.previousStages.plan}}.",
          },
        ],
      },
    },
    {
      workspaceId,
      pipelines: [{ id: id(31), workspaceId }],
      repositories: [{ id: id(35), workspaceId }],
      executionPolicyRevisions: [],
      deliveryPolicyRevisions: [],
      skills: [],
      tools: [],
      approvers: [{ id: id(22), workspaceId }],
      sandboxProviders: ["e2b"],
    },
  );

  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

  const fixture = [
    "-- Update with pnpm test src/lib/factory-definitions/workflow-serial-qualification.test.ts -u",
    "create temp table compiled_serial_bundle as",
    `select $op657$${result.definitionJson}$op657$::text as definition_json,`,
    `  '${result.canonicalDigest}'::text as definition_digest;`,
    "",
  ].join("\n");

  await expect(fixture).toMatchFileSnapshot(
    "../../../supabase/tests/fixtures/factory_workflow_serial_compiled.psql",
  );
});
