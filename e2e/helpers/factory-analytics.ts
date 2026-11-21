import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import type { Database } from "@/lib/supabase/database.types";

const exec = promisify(execFile);
const fixture = z.object({
  workspaceId: z.uuid(),
  slug: z.string().regex(/^analytics-proof-[a-f0-9]{12}$/),
  factoryId: z.uuid(),
  siblingFactoryId: z.uuid(),
  from: z.iso.date(),
  to: z.iso.date(),
  comparisonFrom: z.iso.date(),
  deliveredSessionId: z.uuid(),
  deliveredSessionNumber: z.number().int().positive(),
  producingRunId: z.uuid(),
  failedRunId: z.uuid(),
  mergeId: z.uuid(),
  mergeObservationId: z.uuid(),
  requestObservationId: z.uuid(),
  deploymentObservationId: z.uuid(),
  prUrl: z.url(),
  ownerMemberId: z.uuid(),
  pipelineId: z.uuid(),
  stageId: z.uuid(),
});

function loopback(value: string | undefined, protocol: "http:" | "postgresql:") {
  const url = z
    .url()
    .transform((url) => new URL(url))
    .parse(value);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.protocol !== protocol ||
    !url.port ||
    url.search ||
    url.hash ||
    (protocol === "http:"
      ? url.pathname !== "/" || url.username || url.password
      : url.pathname !== "/postgres")
  ) {
    throw new Error("Analytics qualification requires a dedicated loopback project and app.");
  }
  return url;
}

export async function seedFactoryAnalytics(baseURL: string | undefined, windowDays = 7) {
  const app = loopback(baseURL, "http:");
  const api = loopback(process.env.NEXT_PUBLIC_SUPABASE_URL, "http:");
  const database = loopback(process.env.WALLIE_FACTORY_ANALYTICS_DATABASE_URL, "postgresql:");
  const serviceKey = z.string().min(1).parse(process.env.SUPABASE_SECRET_KEY);
  const admin = createClient<Database>(api.origin, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const workspaceSlug = `analytics-proof-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const ownerEmail = `${workspaceSlug}-owner@example.test`;
  const viewerEmail = `${workspaceSlug}-viewer@example.test`;
  const users: string[] = [];

  const psqlOptions = [
    "-XqAt",
    "--no-password",
    `--host=${database.hostname.replace(/^\[|\]$/g, "")}`,
    `--port=${database.port}`,
    `--username=${decodeURIComponent(database.username)}`,
    "--dbname=postgres",
    "--set=ON_ERROR_STOP=1",
  ];
  const psqlEnvironment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    PGPASSWORD: decodeURIComponent(database.password),
  };

  function runFixtureSql(args: string[]) {
    return exec("psql", [...psqlOptions, ...args], { env: psqlEnvironment, timeout: 20_000 });
  }

  async function runFixtureFile(
    file:
      | "factory-analytics-seed.sql"
      | "factory-benchmark-comparison-seed.sql"
      | "factory-benchmark-results-seed.sql"
      | "factory-benchmark-trial-media-seed.sql"
      | "factory-outcome-release.sql"
      | "factory-score-trends-seed.sql",
    fields: Record<string, string>,
  ): Promise<unknown> {
    const { stdout } = await runFixtureSql([
      ...Object.entries(fields).map(([key, value]) => `--set=${key}=${value}`),
      "--file",
      resolve(__dirname, file),
    ]);
    return JSON.parse(stdout.trim());
  }

  async function createUser(email: string) {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error) throw error;
    users.push(data.user.id);
    return data.user.id;
  }

  async function cleanup() {
    const workspace = await admin.from("workspaces").delete().eq("slug", workspaceSlug);
    const accounts = await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
    const error = workspace.error ?? accounts.find((account) => account.error)?.error;
    if (error) throw error;
  }

  try {
    const ownerId = await createUser(ownerEmail);
    const viewerId = await createUser(viewerEmail);
    const fields = {
      workspace_slug: workspaceSlug,
      owner_id: ownerId,
      owner_email: ownerEmail,
      viewer_id: viewerId,
      viewer_email: viewerEmail,
      repository_numeric_id: String(randomInt(100_000_000, 1_000_000_000)),
      window_days: String(z.number().int().min(1).max(366).parse(windowDays)),
    };
    const data = fixture.parse(await runFixtureFile("factory-analytics-seed.sql", fields));

    return {
      ...data,
      app: app.origin,
      ownerId,
      viewerId,
      ownerEmail,
      viewerEmail,
      runFixtureFile,
      cleanup,
      async observePendingRequest() {
        const { error } = await admin.from("sessions").insert({
          workspace_id: data.workspaceId,
          factory_id: data.factoryId,
          number: 74,
          title: "A recently recorded request",
          creator_member_id: data.ownerMemberId,
          pipeline_id: data.pipelineId,
          current_stage_id: data.stageId,
        });
        if (error) throw error;
      },
      async markProjectionFailed() {
        await runFixtureSql([
          "--command",
          `update internal.factory_outcome_projection_watermarks set status = 'failed'
           where (workspace_id, factory_id, metric_key, metric_revision) =
             ('${data.workspaceId}', '${data.factoryId}', 'workflow_flow', 1)`,
        ]);
      },
      async drainProjections() {
        const batch = z.object({ hasMore: z.boolean() });
        for (let index = 0; index < 20; index++) {
          const { data, error } = await admin.rpc("process_factory_flow_projection", {
            p_limit: 50,
          });
          if (error) throw error;
          if (!batch.parse(data).hasMore) return;
        }
        throw new Error("The disposable Analytics projection queue did not drain.");
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
