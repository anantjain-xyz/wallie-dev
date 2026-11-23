import { createHash } from "node:crypto";

import { expect } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";
import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;
type Scope = { workspaceId: string; factoryId: string };
export const acceptanceCriterion = "Invite only workspace administrators in the first wave.";
export const literalAcceptanceCriterion = "Use the literal &copy; marker in the report.";
export const childTask = "Implement the approved rollout.";
export const childTitle = "Implement the scoped invite rollout";
const evidenceRef = "required:session/prompt";

async function row<T>(operation: PromiseLike<{ data: T; error: unknown }>) {
  const { data, error } = await operation;
  if (error) throw error;
  if (data === null) throw new Error("Triage fixture row is missing.");
  return data;
}

export async function seedTriageAuthority(
  admin: Admin,
  scope: Scope & { userId: string; repositoryId: string; agentId: string },
) {
  const member = await row(
    admin
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", scope.workspaceId)
      .eq("user_id", scope.userId)
      .single(),
  );
  const policy = await row(
    admin.rpc("save_execution_policy", {
      p_workspace_id: scope.workspaceId,
      p_actor_user_id: scope.userId,
      p_expected_revision: 0,
      p_requirements: {
        version: 1,
        maxRepairAttempts: 3,
        maxExecutionMs: 120_000,
        maxTotalTokens: null,
        maxCostUsd: null,
      },
    }),
  );
  const principal = await row(
    admin.rpc("create_service_principal", {
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: scope.userId,
      p_name: "Triage browser proof",
      p_slug: "triage-browser-proof",
    }),
  );
  const grant = await row(
    admin.rpc("approve_factory_execution_grant", {
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: scope.userId,
      p_service_principal_id: principal.id,
      p_budget_payer_member_id: member.id,
      p_github_repository_id: scope.repositoryId,
      p_execution_policy_revision_id: policy.id,
      p_read_context_repository_ids: [],
      p_tool_ids: [],
      p_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      p_expected_version: 0,
      p_command_scopes: ["sessions:create"],
    }),
  );
  const secret = await row(
    admin
      .from("workspace_secrets")
      .insert({
        workspace_id: scope.workspaceId,
        key: "TRIAGE_FIXTURE",
        encrypted_value: "unused-local-fixture",
      })
      .select("id")
      .single(),
  );
  const binding = await row(
    admin.rpc("create_factory_secret_binding", {
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: scope.userId,
      p_factory_agent_id: scope.agentId,
      p_agent_provider: "codex",
      p_execution_grant_id: grant.id,
      p_execution_grant_version: grant.version,
      p_workspace_secret_id: secret.id,
    }),
  );
  return {
    policyId: policy.id,
    executionGrant: { id: grant.id, version: grant.version },
    credentialBindingId: binding.id,
  };
}

export async function configureTriageGraph(
  admin: Admin,
  scope: Scope & {
    userId: string;
    stageId: string;
    definitionRevisionId: string;
    definitionDigest: string;
    promptRevisionId: string;
    grant: { id: string; version: number };
  },
) {
  const profile = {
    definitionRevisionId: scope.definitionRevisionId,
    definitionDigest: scope.definitionDigest,
  };
  const graph = compileWorkflowGraph(
    {
      kind: "structured",
      value: {
        schemaVersion: 1,
        kind: "graph",
        entryNodeId: "scope.approved",
        nodes: [
          {
            id: "scope.approved",
            kind: "human-gate",
            anyoneCanApprove: true,
            approverMemberIds: [],
          },
          {
            id: "route.delivery",
            kind: "route",
            agentPromptRevisionId: scope.promptRevisionId,
            grantId: scope.grant.id,
          },
          {
            id: "agent.invites",
            kind: "agent",
            agentPromptRevisionId: scope.promptRevisionId,
            grantId: scope.grant.id,
          },
        ],
        edges: [
          { id: "scope.continue", kind: "next", from: "scope.approved", to: "route.delivery" },
          { id: "route.invites", kind: "route", from: "route.delivery", to: "agent.invites" },
        ],
        grants: [scope.grant],
        routePolicy: {
          maxNodeVisits: 8,
          maxLoopTraversals: 0,
          nodes: {
            "route.delivery": {
              minimumConfidence: 0.8,
              allowedDestinationIds: ["agent.invites"],
              fallback: { kind: "clarification" },
              foremanProfile: profile,
            },
          },
        },
        delegationPolicy: {
          maxChildren: 1,
          maxConcurrentChildren: 1,
          maxAttempts: 6,
          maxTotalTokens: 500,
          maxTokensPerAttempt: 60,
          maxCostUsd: 3,
          maxCostUsdPerAttempt: 0.4,
          targets: { "agent.invites": profile },
        },
      },
    },
    {
      workspaceId: scope.workspaceId,
      agentPromptRevisions: [{ id: scope.promptRevisionId, workspaceId: scope.workspaceId }],
      approvers: [],
      approvedGrants: [{ ...scope.grant, workspaceId: scope.workspaceId }],
    },
  );
  if (!graph.ok) throw new Error(JSON.stringify(graph.diagnostics));

  const registered = await row(
    admin
      .rpc("register_factory_workflow_graph_revision", {
        p_workspace_id: scope.workspaceId,
        p_factory_id: scope.factoryId,
        p_definition_revision_id: scope.definitionRevisionId,
        p_definition_digest: scope.definitionDigest,
        p_workflow_json: graph.definitionJson,
        p_workflow_digest: graph.canonicalDigest,
      })
      .single(),
  );
  await row(
    admin
      .rpc("configure_factory_workflow_triage", {
        p_workspace_id: scope.workspaceId,
        p_factory_id: scope.factoryId,
        p_actor_user_id: scope.userId,
        p_definition_revision_id: scope.definitionRevisionId,
        p_stage_id: scope.stageId,
        p_graph_revision_id: registered.graph_revision_id,
        p_workflow_digest: graph.canonicalDigest,
        p_expected_version: 0,
      })
      .single(),
  );
  return { id: registered.graph_revision_id, digest: graph.canonicalDigest };
}

export function acceptedScopeArtifact(scope: string) {
  const { definitionJson } = serializeFactoryDefinition({
    version: 1,
    scope,
    acceptanceCriteria: [acceptanceCriterion, literalAcceptanceCriterion],
    evidenceReferences: [evidenceRef],
  });
  return [
    `<!-- wallie-accepted-scope: ${Buffer.from(definitionJson).toString("base64url")} -->`,
    "## Scope",
    scope,
    "",
    "## Acceptance criteria",
    `- ${acceptanceCriterion}`,
    `- ${literalAcceptanceCriterion.replace("&", "\\&")}`,
    "",
    "## Evidence",
    `- \`${evidenceRef}\``,
  ].join("\n");
}

export async function freezeFixtureContext(
  admin: Admin,
  attempt: { workspaceId: string; jobId: string; runId: string },
  inputs: { key: string; body: string }[],
) {
  const required = inputs.map(({ key, body }) => ({
    key,
    utf8Bytes: Buffer.byteLength(body),
    sha256: createDigest(body),
  }));
  const usedUtf8Bytes = required.reduce((sum, input) => sum + input.utf8Bytes, 0);
  const manifest = {
    version: 1,
    required,
    documents: [],
    conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
    budget: {
      maxUtf8Bytes: 16_384,
      maxEstimatedTokens: 16_384,
      usedUtf8Bytes,
      estimatedTokens: usedUtf8Bytes,
    },
  };
  const persisted = await row(
    admin.rpc("pin_factory_run_context", {
      p_workspace_id: attempt.workspaceId,
      p_job_id: attempt.jobId,
      p_run_id: attempt.runId,
      p_attempt_count: 1,
      p_manifest: manifest,
    }),
  );
  expect(persisted.manifest).toEqual(manifest);
  return persisted;
}

function createDigest(body: string) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function dispatchFixtureForeman(
  admin: Admin,
  scope: Scope & { rootSessionId: string; graphDigest: string; approvedRunId: string },
  candidate: string,
) {
  const lease = await row(
    admin
      .rpc("claim_factory_workflow_accepted_triage_route", {
        p_candidate_token: candidate,
      })
      .single(),
  );
  expect(lease).toMatchObject({
    root_session_id: scope.rootSessionId,
    workspace_id: scope.workspaceId,
    factory_id: scope.factoryId,
    workflow_digest: scope.graphDigest,
    node_id: "route.delivery",
    ownership_token: candidate,
  });
  const owner = {
    p_root_session_id: lease.root_session_id,
    p_workspace_id: lease.workspace_id,
    p_factory_id: lease.factory_id,
    p_expected_generation: lease.execution_generation,
    p_ownership_token: lease.ownership_token,
  };
  const route = { ...owner, p_route_occurrence_id: lease.occurrence_id };
  const ticket = z
    .object({
      status: z.literal("issued"),
      issueId: z.string().uuid(),
      foremanRunId: z.string().uuid(),
      sourceCheckpointRunId: z.string().uuid(),
      taskPromptMd: z.string(),
    })
    .parse(await row(admin.rpc("begin_factory_workflow_foreman_inference", route)));
  expect(ticket.sourceCheckpointRunId).toBe(scope.approvedRunId);
  expect(ticket.taskPromptMd).toContain(acceptanceCriterion);

  // Deterministic inference boundary. The real guarded settlement, route, and child commands still run.
  const planJson = JSON.stringify({
    version: 1,
    commands: [
      {
        kind: "route",
        decision: {
          kind: "choose",
          destinationNodeId: "agent.invites",
          confidence: 0.95,
          reason: "The approved scope is ready.",
        },
      },
      { kind: "delegate", targetNodeId: "agent.invites", title: childTitle, promptMd: childTask },
    ],
  });
  await row(
    admin.rpc("settle_factory_workflow_foreman_inference", {
      ...route,
      p_issue_id: ticket.issueId,
      p_outcome: {
        status: "accepted",
        planJson,
        planDigest: createDigest(planJson),
        usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.05 },
      },
    }),
  );
  const first = await row(
    admin.rpc("dispatch_factory_workflow_foreman_command", {
      ...route,
      p_foreman_run_id: ticket.foremanRunId,
      p_ordinal: 1,
    }),
  );
  expect(first).toMatchObject({ status: "accepted", kind: "route", resolution: "selected" });
  const child = z
    .object({
      status: z.literal("accepted"),
      childSessionId: z.string().uuid(),
      jobId: z.string().uuid(),
      runId: z.string().uuid(),
    })
    .parse(
      await row(
        admin.rpc("dispatch_factory_workflow_foreman_command", {
          ...route,
          p_foreman_run_id: ticket.foremanRunId,
          p_ordinal: 2,
        }),
      ),
    );
  expect(
    await row(
      admin.rpc("finish_factory_workflow_accepted_triage_route", {
        ...owner,
        p_occurrence_id: lease.occurrence_id,
        p_completed: true,
      }),
    ),
  ).toBe(true);
  return child;
}

export async function readFixtureChildScope(
  admin: Admin,
  attempt: { workspaceId: string; jobId: string; runId: string },
) {
  const received = z
    .object({
      status: z.literal("required"),
      artifactMarkdown: z.string(),
      pin: z.object({
        rootSessionId: z.string().uuid(),
        approvalId: z.string().uuid(),
        artifactId: z.string().uuid(),
        artifactVersion: z.number().int().positive(),
        artifactDigest: z.string(),
        workflowDigest: z.string(),
      }),
    })
    .parse(
      await row(
        admin.rpc("read_factory_workflow_delegated_scope", {
          p_workspace_id: attempt.workspaceId,
          p_job_id: attempt.jobId,
          p_run_id: attempt.runId,
          p_attempt_count: 1,
        }),
      ),
    );
  const { pin } = received;
  return {
    pin,
    body: received.artifactMarkdown.slice(received.artifactMarkdown.indexOf("\n") + 1),
    key: `approved-scope/${pin.approvalId}/${pin.artifactId}/${pin.artifactVersion}/${pin.artifactDigest}`,
  };
}
