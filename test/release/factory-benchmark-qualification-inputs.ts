import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { compiledFactoryDefinitionSchema } from "@/lib/factory-definitions/schema";
import { replaySha256 } from "@/lib/factory-benchmarks/replay-contracts";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import { FakeSandbox } from "@/lib/sandbox/fake";
import type { SandboxExecOptions } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";

import {
  qualificationPrompt,
  qualificationRef,
  qualificationRepository,
  qualificationTitle,
  receipt,
  type QualificationAdmin,
} from "./factory-benchmark-qualification";

export function runQualificationSql(
  text: string,
  vars: Record<string, string>,
  fixturePassword?: string,
) {
  const url = new URL(process.env.WALLIE_M08_DATABASE_URL ?? "");
  assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  return execFileSync(
    "psql",
    [
      "-X",
      "-qAt",
      "--set=ON_ERROR_STOP=1",
      ...Object.entries(vars).map(([key, value]) => `--set=${key}=${value}`),
    ],
    {
      encoding: "utf8",
      input: text,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
        PGPORT: url.port,
        PGDATABASE: url.pathname.slice(1),
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        WALLIE_M08_SQL_FIXTURE_PASSWORD: fixturePassword,
      },
      timeout: 30_000,
    },
  ).trim();
}

export function gitInFixture(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], {
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture author",
      GIT_AUTHOR_EMAIL: "benchmark@example.test",
      GIT_COMMITTER_NAME: "Fixture author",
      GIT_COMMITTER_EMAIL: "benchmark@example.test",
    },
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
}

export async function archiveQualificationSource(directory: string) {
  const origin = join(directory, "origin.git");
  gitInFixture(directory, "init", "--quiet", "--bare", origin);
  const historical = new FakeSandbox(undefined, { passthroughExec: true });
  try {
    await historical.writeFile(join(historical.repoPath, "README.md"), "one\ntwo\nthree\n");
    gitInFixture(historical.repoPath, "add", "README.md");
    gitInFixture(historical.repoPath, "commit", "-qm", "Archive source");
    const archivedCommit = gitInFixture(historical.repoPath, "rev-parse", "HEAD");
    const archivedTree = gitInFixture(historical.repoPath, "rev-parse", "HEAD^{tree}");
    gitInFixture(historical.repoPath, "push", "--quiet", origin, `HEAD:${qualificationRef}`);
    await historical.writeFile(join(historical.repoPath, "README.md"), "moving default\n");
    gitInFixture(historical.repoPath, "commit", "-qam", "Advance default");
    gitInFixture(historical.repoPath, "push", "--quiet", origin, "HEAD:refs/heads/main");
    return { origin, archivedCommit, archivedTree };
  } finally {
    await historical.stop();
  }
}

export async function seedQualificationSource(input: {
  admin: QualificationAdmin;
  archivedCommit: string;
  password: string;
}) {
  const namespace = randomUUID().split("-")[0];
  const fixtureId = (slot: number) =>
    `${namespace}-0000-4000-8000-${String(slot).padStart(12, "0")}`;
  const ownerEmail = `m08-qualification-${namespace}@example.test`;
  const actorId = fixtureId(1);
  const agentPrompt = "Record a measured result.";
  const definition = compiledFactoryDefinitionSchema.parse({
    schemaVersion: 1,
    kind: "serial",
    sandboxProvider: "vercel",
    agent: {
      provider: "codex",
      model: "gpt-5.5",
      effort: null,
      concurrencyLimit: 4,
      stallTimeoutMs: 90_000,
      maxRetries: 0,
      maxTurns: 4,
    },
    implementationAgent: {
      agentId: fixtureId(8),
      promptRevisionId: fixtureId(9),
      promptMd: agentPrompt,
      promptSha256: replaySha256(agentPrompt),
    },
    pipelineId: fixtureId(6),
    repositoryId: fixtureId(5),
    skillIds: [],
    toolIds: [],
    executionPolicyRevisionId: null,
    deliveryPolicyRevisionId: null,
    operatingRulesMd: "",
    operatingRuleStageIds: [],
    stages: [
      {
        id: fixtureId(7),
        slug: "run",
        name: "Run",
        description: "",
        promptTemplateMd: "{{session.prompt}}",
        anyoneCanApprove: true,
        approverMemberIds: [],
        previousStageIds: [],
      },
    ],
  });
  const required = [
    ["session/title", qualificationTitle],
    ["session/prompt", qualificationPrompt],
  ].map(([key, body]) => ({ key, ...fingerprintRunContextInput(body) }));
  const size = required.reduce((sum, item) => sum + item.utf8Bytes, 0);
  const context = {
    version: 1,
    required,
    documents: [],
    conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
    budget: {
      maxUtf8Bytes: 131072,
      maxEstimatedTokens: 32768,
      usedUtf8Bytes: size,
      estimatedTokens: size,
    },
  };
  runQualificationSql(
    readFileSync(new URL("./benchmark-trial-source.sql", import.meta.url), "utf8"),
    {
      namespace,
      fixture_login: "true",
      fixture_email: ownerEmail,
      fixture_slug: `m08-qualification-${namespace}`,
      prompt: qualificationPrompt,
      installation_id: String(624_000_000_000 + Number.parseInt(namespace, 16)),
      repository_id: String(624_000_000_000 + Number.parseInt(namespace, 16)),
      retained_ref: qualificationRef,
      definition: JSON.stringify(definition),
      context_manifest: JSON.stringify(context),
      commit_sha: input.archivedCommit,
    },
    input.password,
  );
  const workspaceId = fixtureId(2);
  const { id: factoryId } = await receipt(
    input.admin
      .from("factories")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("is_default", true)
      .single(),
  );
  const secondDefinition = {
    ...definition,
    agent: { ...definition.agent, maxTurns: 5 },
  };
  const secondDefinitionJson = JSON.stringify(secondDefinition);
  runQualificationSql(
    `
    begin;
    set local request.jwt.claim.role = 'service_role';
    insert into public.agent_runs(id, workspace_id, session_id, stage_id, stage_slug,
      run_type, model_provider, model_name, status, attempt_count, finished_at)
    values (:'missing_run', :'workspace', :'session', :'stage', 'run', 'project',
      'codex', 'gpt-5.5', 'success', 1, clock_timestamp());
    insert into public.factory_definition_revisions(
      id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
    )
    values (:'candidate', :'workspace', :'factory', 1, :'definition', :'digest', :'actor');
    commit;
  `,
    {
      missing_run: fixtureId(14),
      workspace: workspaceId,
      session: fixtureId(11),
      stage: fixtureId(7),
      candidate: fixtureId(16),
      factory: factoryId,
      definition: secondDefinitionJson,
      digest: replaySha256(secondDefinitionJson),
      actor: actorId,
    },
  );
  const sibling = await receipt(
    input.admin.rpc("create_factory", {
      p_workspace_id: workspaceId,
      p_actor_user_id: actorId,
      p_name: "Unrelated qualification factory",
      p_slug: "unrelated",
    }),
  );
  return {
    workspaceId,
    factoryId,
    actorUserId: actorId,
    ownerEmail,
    memberId: fixtureId(3),
    sourceRunId: fixtureId(13),
    missingRunId: fixtureId(14),
    siblingFactoryId: sibling.id,
    definition: { id: fixtureId(10), bytes: JSON.stringify(definition) },
    candidate: { id: fixtureId(16), bytes: secondDefinitionJson },
  };
}

class QualificationSandbox extends FakeSandbox {
  override exec(command: string, args: string[], options?: SandboxExecOptions) {
    // The replay worker supplies the pinned Linux image's PATH. Use this host's
    // Node binary for the same sanitized command in the local transport.
    if (command === "env" && args[0] === "-i" && args.includes("GIT_ALLOW_PROTOCOL=")) {
      const executable = args.indexOf("node");
      if (executable >= 0 && args[executable + 1] === "-e") {
        const local = [...args];
        local[executable] = process.execPath;
        return super.exec(command, local, options);
      }
    }
    return super.exec(command, args, options);
  }
}

export function openSyntheticReplaySandbox(origin: string) {
  const sandbox = new QualificationSandbox(undefined, { passthroughExec: true });
  sandbox.scriptExec(
    ({ cmd, args }) =>
      cmd === "git" &&
      args.join(" ") === `remote add origin https://github.com/${qualificationRepository}.git`,
    () => {
      gitInFixture(sandbox.repoPath, "remote", "add", "origin", origin);
      return [];
    },
  );
  return sandbox;
}

export function authenticatedQualificationViewer(input: {
  url: string;
  publishableKey: string;
  userId: string;
}) {
  const url = new URL(input.url);
  assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  const secret = process.env.WALLIE_M08_LOCAL_JWT_SECRET;
  assert(secret, "The isolated project must provide its local test signing key.");
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ typ: "JWT", alg: "HS256" });
  const payload = encode({
    aud: "authenticated",
    role: "authenticated",
    sub: input.userId,
    exp: Math.floor(Date.now() / 1000) + 180,
  });
  const signature = createHmac("sha256", secret)
    .update(header + "." + payload)
    .digest("base64url");
  return createClient<Database, "public">(input.url, input.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + header + "." + payload + "." + signature } },
  });
}
