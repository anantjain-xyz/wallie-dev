import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell/app-shell";
import { isProductionDeploy } from "@/env/deploy";
import { buildWallieSessionData } from "@/features/wallie/data";
import { RunFailuresPreview } from "./preview-client";

const now = "2026-11-08T14:00:00.000Z";
const workspace = { id: "failure-proof-workspace", name: "Wallie", slug: "proof" };
const scenarios = [
  {
    id: "configuration",
    title: "Configuration",
    category: "configuration",
    code: "sandbox_configuration",
  },
  { id: "agent-exit", title: "Agent exit", category: "agent_exit", code: "agent_exit" },
  { id: "timeout", title: "Timeout", category: "timeout", code: "timeout" },
  {
    id: "budget",
    title: "Execution budget",
    category: "budget",
    code: "budget",
  },
  {
    id: "publication",
    title: "Publication",
    category: "publication",
    code: "publication",
  },
  { id: "legacy", title: "Historical cause unavailable", category: null, code: null },
  {
    id: "success",
    title: "Completed run with a test failure in activity",
    category: null,
    code: null,
  },
];

/** Real run cards built from persisted row fixtures, without launching or retrying jobs. */
export default function RunFailuresPage() {
  if (isProductionDeploy()) notFound();
  const data = buildWallieSessionData({
    sessionGithubRepositoryId: null,
    memberIndex: new Map(),
    repository: null,
    requiresVercelSandbox: false,
    vercelSandboxConnection: {
      connected: true,
      lastValidationError: null,
      status: "connected",
      projectId: null,
      projectName: null,
      teamId: null,
    },
    runs: scenarios.map((scenario, index) => ({
      id: scenario.id,
      attemptCount: index + 1,
      branch_name: "wallie/session-42/build",
      created_at: now,
      cost_provenance: "unavailable",
      finished_at: "2026-11-08T14:30:38.000Z",
      input_tokens: null,
      output_tokens: null,
      total_cost_usd: null,
      token_provenance: "unavailable",
      usage_finalized_at: "2026-11-08T14:30:38.000Z",
      last_activity_at: "2026-11-08T14:30:38.000Z",
      model_name: "gpt-5.5",
      model_provider: "codex",
      run_type: "code",
      sandbox_id: "sandbox-42-build-long-identifier-for-mobile-wrapping",
      sandbox_provider: "vercel",
      started_at: now,
      stage_id: "build",
      stage_name: "Build",
      stage_slug: "build",
      status: scenario.id === "success" ? "success" : "error",
      triggered_by_member_id: null,
      updated_at: "2026-11-08T14:30:38.000Z",
    })),
    messages: scenarios.flatMap((scenario) => [
      {
        agent_run_id: scenario.id,
        id: `${scenario.id}-progress`,
        kind: "progress",
        message_md: "Tests failed on the first attempt; I’m checking the assertions.",
        created_at: "2026-11-08T14:05:00.000Z",
      },
      ...(scenario.id === "legacy"
        ? []
        : [
            {
              agent_run_id: scenario.id,
              id: `${scenario.id}-diagnostic`,
              kind: "error",
              message_md:
                scenario.id === "success"
                  ? "Tests failed during development; the agent fixed them before completing the run."
                  : "Provider request failed (403). Authorization: Bearer fixture-secret-that-must-stay-private; api_key=fixture-api-key-that-must-stay-private",
              created_at: "2026-11-08T14:25:00.000Z",
            },
          ]),
      ...(scenario.category && scenario.code
        ? [
            {
              agent_run_id: scenario.id,
              id: `${scenario.id}-terminal`,
              kind: "run_failure",
              message_md: JSON.stringify({
                version: 1,
                category: scenario.category,
                code: scenario.code,
              }),
              created_at: "2026-11-08T14:30:38.000Z",
            },
          ]
        : []),
    ]),
  });
  return (
    <AppShell
      workspace={workspace}
      onboarding={null}
      pathnameOverride="/w/proof/sessions/42"
      viewerId="proof-viewer"
      viewerEmail="preview@example.com"
      viewerAvatarUrl={null}
      workspaceAvatarUrl={null}
    >
      <RunFailuresPreview
        runs={data.runs}
        initialNow={now}
        titles={Object.fromEntries(scenarios.map(({ id, title }) => [id, title]))}
      />
    </AppShell>
  );
}
