import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod/v4";

import { factoryDeliveryCommandSchema } from "@/lib/factory-delivery-commands/contracts";

import type { AutomationInputScope } from "./factory-automation-input";

export function fixtureSql(
  databaseUrl: string,
  sql: string,
  variables: Record<string, string> = {},
) {
  const url = new URL(databaseUrl);
  assert(
    ["postgresql:", "postgres:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !/[?#]/.test(url.href),
  );
  try {
    return execFileSync(
      "psql",
      [
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        ...Object.entries(variables).flatMap(([key, value]) => ["-v", `${key}=${value}`]),
        url.toString(),
      ],
      {
        input: sql,
        encoding: "utf8",
        env: { NODE_ENV: "test", PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 20_000,
      },
    ).trim();
  } catch (error) {
    const details =
      error instanceof Error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim().replaceAll(url.toString(), "[local database]")
        : "";
    throw new Error(
      ["Could not query the disposable M12 fixture database.", details].join(" ").trim(),
    );
  }
}

const id = z.string().uuid();
const outcome = z.strictObject({
  occurrences: z.array(
    z.object({
      id,
      automationId: id,
      revisionId: id,
      namespace: z.string(),
      sourceKey: z.string(),
      status: z.enum(["pending", "admitted", "denied"]),
      reason: z.string().nullable(),
      event: z.record(z.string(), z.unknown()),
      sessionId: id.nullable(),
      receiptId: id.nullable(),
      receiptLink: z
        .object({
          id,
          sessionId: id,
          grantId: id,
          grantVersion: z.number(),
          repositoryId: id,
          admissionId: id,
        })
        .nullable(),
      jobs: z.array(id),
    }),
  ),
  github: z.array(
    z.object({
      id,
      number: z.number(),
      sourceKey: z.string(),
      disposition: z.string(),
      occurrences: z.number(),
    }),
  ),
  linear: z.array(
    z.object({
      issueId: id,
      spanId: z.string(),
      baseline: z.boolean(),
      sourceKey: z.string(),
    }),
  ),
});
export type IntakeWitness = z.infer<typeof outcome>;

const readIntakeSql = `
with occurrence_rows as (
  select jsonb_build_object(
    'id', o.id, 'automationId', o.automation_id, 'revisionId', o.revision_id,
    'namespace', o.source_namespace, 'sourceKey', o.source_key, 'status', o.status,
    'reason', o.reason, 'event', o.event, 'sessionId', o.session_id, 'receiptId', o.mutation_receipt_id,
    'receiptLink', case when r.id is not null then jsonb_build_object(
      'id', r.id, 'sessionId', r.session_id, 'grantId', r.grant_id, 'grantVersion', r.grant_version,
      'repositoryId', r.writer_repository_id, 'admissionId', r.admission_id
    ) end,
    'jobs', coalesce((select jsonb_agg(job.id order by job.id) from public.agent_jobs job
      where job.session_id = o.session_id and job.workspace_id = o.workspace_id), '[]'::jsonb)
  ) as witness, o.automation_id
  from internal.factory_automation_occurrences o
  left join internal.session_mutation_receipts r on
    (r.workspace_id, r.factory_id, r.request_id) = (o.workspace_id, o.factory_id, o.id)
    and r.operation = 'create'
  where (o.workspace_id, o.factory_id) = (:'workspace'::uuid, :'factory'::uuid)
), github_rows as (
  select jsonb_build_object('id', g.id, 'number', g.pull_request_number, 'sourceKey', g.source_key,
    'disposition', g.disposition, 'occurrences', g.occurrence_count) as witness, g.recorded_at
  from internal.github_automation_pr_deliveries g
  where (g.workspace_id, g.factory_id) = (:'workspace'::uuid, :'factory'::uuid)
), linear_rows as (
  select jsonb_build_object('issueId', span.source_issue_id, 'spanId', span.source_span_id,
    'baseline', span.baseline, 'sourceKey',
    encode(sha256(convert_to(jsonb_build_array(span.source_issue_id, span.source_span_id)::text, 'UTF8')), 'hex')
  ) as witness, span.started_at
  from internal.issue_automation_state_spans span
  where (span.workspace_id, span.factory_id) = (:'workspace'::uuid, :'factory'::uuid)
)
select jsonb_build_object(
  'occurrences', (select coalesce(jsonb_agg(witness order by automation_id), '[]') from occurrence_rows),
  'github', (select coalesce(jsonb_agg(witness order by recorded_at), '[]') from github_rows),
  'linear', (select coalesce(jsonb_agg(witness order by started_at), '[]') from linear_rows)
);`;

export function readIntake(databaseUrl: string, scope: AutomationInputScope) {
  return outcome.parse(
    JSON.parse(
      fixtureSql(databaseUrl, readIntakeSql, {
        workspace: scope.workspaceId,
        factory: scope.factoryId,
      }),
    ),
  );
}

export function assertIntake(
  state: IntakeWitness,
  scope: AutomationInputScope,
  mode: "baseline" | "admitted" | "revoked",
) {
  const received = new Map(state.occurrences.map((row) => [row.automationId, row]));
  const expectedCount = mode === "baseline" ? 3 : mode === "admitted" ? 4 : 5;
  assert.equal(state.occurrences.length, expectedCount);
  assert.equal(state.github.length, mode === "revoked" ? 6 : 4);
  assert.equal(received.size, expectedCount, "Each rule must have only one occurrence.");
  for (const [name, rule] of Object.entries(scope.rules)) {
    const row = received.get(rule.automationId);
    if ((name === "linear" && mode === "baseline") || (name === "revoked" && mode !== "revoked")) {
      assert.equal(row, undefined);
      continue;
    }
    assert(row, `No receipt for ${name}.`);
    assert.equal(row.revisionId, rule.revisionId);
    if (name === "schedule") {
      const instant = new Date(scope.scheduledFor).toISOString();
      assert.equal(row.namespace, "schedule");
      assert.equal(row.sourceKey, instant);
      assert.deepEqual(row.event, { kind: "schedule", scheduledFor: instant });
    } else if (name === "linear") {
      const span = state.linear[1];
      assert(span);
      assert.equal(row.namespace, "linear.issue-state");
      assert.equal(row.sourceKey, span.sourceKey);
      assert.equal(row.event.stateId, scope.linear.targetStateId);
      assert.equal(row.event.teamId, scope.linear.teamId);
    } else {
      const [number, branch] =
        name === "github"
          ? [41, "main"]
          : name === "paused"
            ? [42, "qualification-paused"]
            : [43, "qualification-revoked"];
      const deliveries = state.github.filter((receipt) => receipt.number === number);
      assert.deepEqual(
        deliveries.map(({ disposition, occurrences }) => [disposition, occurrences]),
        [
          ["accepted", 1],
          ["duplicate", 0],
        ],
      );
      assert.equal(row.namespace, "github.pr");
      assert(deliveries.every(({ sourceKey }) => sourceKey === row.sourceKey));
      assert.deepEqual(row.event, {
        kind: "pull-request",
        repositoryId: scope.repository.id,
        action: "merged",
        baseBranch: branch,
      });
    }
    if (name === "paused" || name === "revoked") {
      assert.equal(row.status, name === "paused" ? "pending" : "denied");
      assert.equal(row.reason, name === "paused" ? "paused" : "invalid_assignment");
      assert.equal(row.sessionId, null);
      assert.equal(row.receiptId, null);
      assert.equal(row.receiptLink, null);
      assert.deepEqual(row.jobs, []);
      continue;
    }
    assert.equal(row.status, "admitted");
    assert.equal(row.reason, null);
    assert(row.sessionId && row.receiptId);
    assert.deepEqual(row.receiptLink, {
      id: row.receiptId,
      sessionId: row.sessionId,
      grantId: scope.grant.id,
      grantVersion: scope.grant.version,
      repositoryId: scope.repository.id,
      admissionId: row.id,
    });
    assert.equal(row.jobs.length, 1, "One occurrence must create exactly one root job.");
  }
  assert.deepEqual(
    state.linear.map(({ issueId, spanId, baseline }) => [issueId, spanId, baseline]),
    mode === "baseline"
      ? [[scope.linear.issueId, `${scope.linear.issueId}:baseline`, true]]
      : [
          [scope.linear.issueId, `${scope.linear.issueId}:baseline`, true],
          [scope.linear.issueId, `${scope.linear.issueId}:matching`, false],
        ],
  );
  const admitted = state.occurrences.filter(({ status }) => status === "admitted");
  assert.equal(new Set(admitted.map(({ sessionId }) => sessionId)).size, admitted.length);
}

const deliveryScope = z.strictObject({
  workspaceId: id,
  factoryId: id,
  actorUserId: id,
  commandId: id,
  failedCommandId: id,
});
export type DeliveryScope = z.infer<typeof deliveryScope>;
export type DeliveryCommand = z.infer<typeof factoryDeliveryCommandSchema>;

export function seedDelivery(databaseUrl: string, namespace: string) {
  const seed = fileURLToPath(
    new URL("./factory-automation-runtime-delivery.psql", import.meta.url),
  );
  return deliveryScope.parse(
    JSON.parse(
      fixtureSql(databaseUrl, "\\i :m12_delivery_seed\n", {
        m12_delivery_seed: seed,
        op651_fixture_namespace: namespace,
      }),
    ),
  );
}

export function readDispatchHistory(databaseUrl: string, scope: DeliveryScope) {
  return z.array(z.tuple([z.string(), z.string().nullable(), id.nullable()])).parse(
    JSON.parse(
      fixtureSql(
        databaseUrl,
        `
      select coalesce(jsonb_agg(jsonb_build_array(dispatch_state, outcome, deployment_observation_id)
        order by id), '[]'::jsonb)
      from internal.factory_delivery_command_receipts
      where (workspace_id, factory_id, command_id) = (:'workspace', :'factory', :'command');
    `,
        { workspace: scope.workspaceId, factory: scope.factoryId, command: scope.commandId },
      ),
    ),
  );
}

export function assertDeliverySucceeded(command: DeliveryCommand) {
  assert.equal(command.dispatchState, "accepted", "Provider acceptance is required.");
  assert.equal(command.outcome, "succeeded", "Deployment outcome did not succeed.");
  assert(command.deploymentObservationId, "An authenticated deployment observation is required.");
}
