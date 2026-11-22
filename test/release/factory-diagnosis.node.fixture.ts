import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { diagnosisReceiptSchema } from "@/lib/factory-diagnosis/contracts";
import { drainFactoryDiagnoses } from "@/lib/factory-diagnosis/worker";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

const workdir = process.env.WALLIE_FACTORY_DIAGNOSIS_DB_WORKDIR;
const localHostnames = ["localhost", "127.0.0.1", "[::1]"];
const fixtureInformation = z.object({
  workspace_id: z.uuid(),
  factory_id: z.uuid(),
  cohort_id: z.uuid(),
  prompt_revision_id: z.uuid(),
  manager_user_id: z.uuid(),
  reader_user_id: z.uuid(),
  run_id: z.uuid(),
  asset_path: z.templateLiteral([z.uuid(), "/", z.uuid(), "/", z.uuid()]),
});
const localStatus = z.object({
  API_URL: z.url(),
  DB_URL: z.url(),
  ANON_KEY: z.string().min(1),
  SERVICE_ROLE_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
});

function disposableToken(userId: string, jwtSecret: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 120,
  });
  const claims = header + "." + body;
  return claims + "." + createHmac("sha256", jwtSecret).update(claims).digest("base64url");
}

it.skipIf(!workdir)("executes one real scoped diagnosis through the Node worker", async () => {
  if (!workdir) throw new Error("An exclusive local Supabase fixture directory is required.");
  const config = localStatus.parse(
    JSON.parse(
      execFileSync("supabase", ["status", "--output", "json", "--workdir", resolve(workdir)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      }),
    ),
  );
  const api = new URL(config.API_URL);
  const db = new URL(config.DB_URL);
  if (
    api.protocol !== "http:" ||
    db.protocol !== "postgresql:" ||
    !localHostnames.includes(api.hostname) ||
    !localHostnames.includes(db.hostname) ||
    db.pathname !== "/postgres"
  )
    throw new Error("Diagnosis qualification requires loopback Supabase and PostgreSQL.");
  const localFetch = fetch;
  const admin = createClient<Database>(api.origin, config.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: localFetch },
  });
  const initial = await admin.rpc("get_git_continuity_release_state");
  if (initial.error || !initial.data[0]) throw new Error("Could not read the local release gate.");
  const wasEnabled = initial.data[0].enabled;
  const prefix = String(randomInt(63_590_000, 63_599_999));
  const apiKey = "synthetic-diagnosis-provider-key";
  const fixtureSql = resolve("supabase/tests/fixtures/factory_diagnosis_source.psql");
  const psql = (args: string[]) =>
    execFileSync(
      "psql",
      [
        "-XqAt",
        "--no-password",
        "--set=ON_ERROR_STOP=1",
        "--single-transaction",
        "--host=" + db.hostname.replace(/^\[|\]$/g, ""),
        "--port=" + db.port,
        "--username=" + decodeURIComponent(db.username),
        "--dbname=postgres",
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          PGPASSWORD: decodeURIComponent(db.password),
        },
      },
    );

  vi.stubEnv("WALLIE_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
  let fixture: z.infer<typeof fixtureInformation> | undefined;
  try {
    const seeded = psql([
      "--set=diagnosis_fixture_prefix=" + prefix,
      "--set=diagnosis_inference_ciphertext=" + encryptSecretValue(apiKey),
      "--file=" + fixtureSql,
      "--command=select jsonb_build_object('workspace_id',scope.workspace_id,'factory_id',scope.factory_id," +
        "'cohort_id',cohort.id,'prompt_revision_id',agent.id,'manager_user_id',pg_temp.diagnosis_fixture_id(2)," +
        "'reader_user_id',pg_temp.diagnosis_fixture_id(3),'run_id',source.run_id," +
        "'asset_path',scope.workspace_id::text || '/' || source.run_id::text || '/' || source.asset_id::text) " +
        "from diagnosis_scope scope cross join diagnosis_cohort cohort " +
        "cross join diagnosis_agent agent cross join diagnosis_source source",
    ]);
    fixture = fixtureInformation.parse(JSON.parse(seeded.trim().split("\n").at(-1) ?? ""));

    const scope = { p_workspace_id: fixture.workspace_id, p_factory_id: fixture.factory_id };
    const enqueued = await admin.rpc("request_factory_diagnosis", {
      ...scope,
      p_cohort_id: fixture.cohort_id,
      p_actor_user_id: fixture.manager_user_id,
      p_request_id: randomUUID(),
      p_prompt_revision_id: fixture.prompt_revision_id,
    });
    expect(enqueued.error).toBeNull();
    const queued = diagnosisReceiptSchema.parse(enqueued.data);
    expect(queued.status).toBe("queued");
    expect(queued.evidence).toHaveLength(1);
    const evidence = queued.evidence?.[0];
    if (!evidence) throw new Error("The diagnosis fixture did not freeze a producing step.");
    expect(evidence.run_id).toBe(fixture.run_id);
    expect(evidence.stage_slug).toBe("build");
    expect(evidence.producing_agent_id).not.toBe(queued.agent_id);

    const run = () =>
      admin
        .from("agent_runs")
        .select("id,status,attempt_count,stage_id,agent_id")
        .eq("workspace_id", scope.p_workspace_id)
        .eq("id", evidence.run_id)
        .single();
    const before = await run();
    expect(before.error).toBeNull();

    const syntheticFetch = vi.fn<typeof fetch>(async (input, options) => {
      const request = new Request(input, options);
      expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(request.headers.get("Authorization")).toBe("Bearer " + apiKey);
      const body = await request.text();
      expect(body).toContain(evidence.member_id);
      expect(body).toContain(evidence.run_id);
      expect(body).not.toContain(apiKey);
      expect(body).not.toContain("production-only");
      expect(body).not.toContain('"tools":');
      return Response.json({
        model: queued.model_id,
        provider: "openai",
        id: "synthetic-diagnosis-smoke",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                version: 1,
                summary: "The retained build step returned a validation failure.",
                uncertainty: "The evidence does not establish what caused the failure.",
                claims: [
                  {
                    member_ids: [evidence.member_id],
                    inferred_cause:
                      "The observed validation failure could reflect a missing fixture.",
                    uncertainty: "The retained command identity supplies no input details.",
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 122, completion_tokens: 64 },
      });
    });
    vi.stubGlobal("fetch", syntheticFetch);
    await expect(drainFactoryDiagnoses(admin, "node")).resolves.toBe(true);
    await expect(drainFactoryDiagnoses(admin, "node")).resolves.toBe(false);
    expect(syntheticFetch).toHaveBeenCalledOnce();

    const readerUserId = fixture.reader_user_id;
    const reader = createClient<Database>(api.origin, config.ANON_KEY, {
      accessToken: async () => disposableToken(readerUserId, config.JWT_SECRET),
      global: { fetch: localFetch },
    });
    const fetched = await reader.rpc("get_factory_diagnosis", {
      ...scope,
      p_diagnosis_id: queued.diagnosis_id,
    });
    expect(fetched.error).toBeNull();
    const completed = diagnosisReceiptSchema.parse(fetched.data);
    expect(completed).toMatchObject({
      diagnosis_id: queued.diagnosis_id,
      evidence_digest: queued.evidence_digest,
      prompt_revision_id: fixture.prompt_revision_id,
      status: "completed",
      evidence: [evidence],
      result: {
        uncertainty: expect.stringContaining("Sample support is below the cohort minimum."),
        claims: [{ member_ids: [evidence.member_id] }],
      },
      trace: { provider_request_id: "synthetic-diagnosis-smoke", worker_runtime: "node" },
      usage: { input_tokens: 122, output_tokens: 64 },
    });
    expect(JSON.stringify(fetched.data)).not.toContain(apiKey);
    const after = await run();
    expect(after.error).toBeNull();
    expect(after.data).toEqual(before.data);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    try {
      if (fixture) {
        psql([
          "--command=set local storage.allow_delete_query = 'true'; " +
            "delete from storage.objects where bucket_id = 'session-validation-evidence' " +
            "and name = '" +
            fixture.asset_path +
            "'; " +
            "delete from public.workspaces where id = '" +
            fixture.workspace_id +
            "'; " +
            "delete from auth.users where id::text like '" +
            prefix +
            "-0000-4000-8000-%';",
        ]);
      }
    } finally {
      if (!wasEnabled) {
        const state = await admin.rpc("get_git_continuity_release_state");
        const head = state.data?.[0];
        if (state.error || !head) throw new Error("Could not inspect the local release gate.");
        if (head.enabled) {
          const restored = await admin.rpc("set_git_continuity_release", {
            p_enabled: false,
            p_expected_revision: head.revision,
            p_reason: "Restore gate after isolated factory diagnosis smoke",
          });
          if (restored.error) throw new Error("Could not restore the local release gate.");
        }
      }
    }
  }
});
