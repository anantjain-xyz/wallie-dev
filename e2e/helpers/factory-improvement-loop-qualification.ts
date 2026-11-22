import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { factoryImprovementOutcomesSchema } from "../../src/lib/factory-proposals/outcome-contracts";
import type { Database } from "../../src/lib/supabase/database.types";
import {
  improvementQualificationDatabaseEnvironment,
  loopbackQualificationUrl,
  type FactoryImprovementLoopManifest,
} from "../../test/release/factory-improvement-loop-contract";

type Manifest = FactoryImprovementLoopManifest;
type Activation = Manifest["baseline"];
type AdmissionPhase = "baseline" | "adopted" | "restored";

const pinSchema = z.object({
  sessionId: z.string().uuid(),
  activationNumber: z.number().int().positive(),
  revisionId: z.string().uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  pinHash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Pin = z.output<typeof pinSchema>;

const auditSchema = z.object({
  baseline: pinSchema,
  adopted: pinSchema,
  restored: pinSchema,
  outcomes: factoryImprovementOutcomesSchema,
});
const exec = promisify(execFile);

export function qualificationAppOrigin(manifest: Manifest, requested: string | undefined) {
  const app = loopbackQualificationUrl(requested ?? "", ["http:"]);
  if (requested !== app.origin || app.origin !== manifest.appOrigin) {
    throw new Error("The manifest and the isolated Chromium app origin must match.");
  }
  return app.origin;
}

export async function authenticateQualificationOwner(
  page: Page,
  manifest: Pick<Manifest, "actorUserId" | "appOrigin" | "ownerEmail">,
) {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabase = loopbackQualificationUrl(raw, ["http:"]);
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (raw !== supabase.origin || !serviceKey || !publishableKey) {
    throw new Error("Provide the configured disposable Supabase URL and keys.");
  }

  const admin = createClient<Database>(supabase.origin, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const generated = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: manifest.ownerEmail,
    options: { redirectTo: manifest.appOrigin },
  });
  const tokenHash = generated.data?.properties?.hashed_token;
  if (generated.error || !tokenHash || generated.data.user?.id !== manifest.actorUserId) {
    throw new Error(
      "The disposable Auth project did not issue a link for the exact fixture owner.",
    );
  }
  const cookies = new Map<string, string>();
  const session = createServerClient<Database>(supabase.origin, publishableKey, {
    cookies: {
      getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
      setAll: (values) => values.forEach(({ name, value }) => cookies.set(name, value)),
    },
  });
  const signedIn = await session.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  if (signedIn.error || signedIn.data.user?.id !== manifest.actorUserId || !cookies.size) {
    throw new Error("The exact fixture owner could not sign in.");
  }
  await page
    .context()
    .addCookies(Array.from(cookies, ([name, value]) => ({ name, value, url: manifest.appOrigin })));
}

async function runQualificationSql(
  manifest: Manifest,
  action: "admit" | "smoke" | "audit",
  values: Record<string, string>,
) {
  const databaseEnvironment = improvementQualificationDatabaseEnvironment(
    process.env.WALLIE_FACTORY_IMPROVEMENT_DB_URL ?? "",
  );
  const inputs = {
    workspace_id: manifest.workspaceId,
    workspace_slug: manifest.workspaceSlug,
    factory_id: manifest.factoryId,
    actor_user_id: manifest.actorUserId,
    proposal_id: manifest.proposalId,
    proposal_revision_id: manifest.proposalRevisionId,
    publication_id: manifest.publication.id,
    publication_head_sha: manifest.publication.headCommitSha,
    baseline_activation: String(manifest.baseline.activationNumber),
    baseline_revision_id: manifest.baseline.revisionId,
    baseline_digest: manifest.baseline.digest,
    candidate_revision_id: manifest.candidate.revisionId,
    candidate_digest: manifest.candidate.digest,
    ...values,
  };
  const { stdout } = await exec(
    "psql",
    [
      "-XqAtw",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      `${action}=1`,
      ...Object.entries(inputs).flatMap(([name, value]) => ["-v", `${name}=${value}`]),
      "-f",
      resolve(__dirname, "factory-improvement-loop-qualification.psql"),
    ],
    {
      env: { ...databaseEnvironment, PGSSLMODE: "disable" },
      timeout: 30_000,
    },
  );
  return JSON.parse(stdout) as unknown;
}

function admissionRequestId(runId: string, phase: AdmissionPhase) {
  const bytes = createHash("sha256").update(`${runId}:${phase}`).digest("hex").slice(0, 32);
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-4${bytes.slice(13, 16)}-8${bytes.slice(17, 20)}-${bytes.slice(20)}`;
}

export async function admitQualificationSession(
  manifest: Manifest,
  phase: AdmissionPhase,
  expected: Activation,
) {
  const pin = pinSchema.parse(
    await runQualificationSql(manifest, "admit", {
      phase,
      request_id: admissionRequestId(manifest.runId, phase),
      expected_activation: String(expected.activationNumber),
      expected_revision_id: expected.revisionId,
      expected_digest: expected.digest,
    }),
  );
  expect(pin).toMatchObject(expected);
  return pin;
}

export async function prepareQualificationRollbackSmoke(manifest: Manifest, adopted: Activation) {
  const result = z.object({ smokePassed: z.literal(true) }).parse(
    await runQualificationSql(manifest, "smoke", {
      expected_activation: String(adopted.activationNumber),
      expected_revision_id: adopted.revisionId,
      expected_digest: adopted.digest,
    }),
  );
  return result.smokePassed;
}

export async function auditQualificationRollback(
  manifest: Manifest,
  pins: { baseline: Pin; adopted: Pin; restored: Pin },
) {
  const audit = auditSchema.parse(
    await runQualificationSql(manifest, "audit", {
      baseline_session_id: pins.baseline.sessionId,
      adopted_session_id: pins.adopted.sessionId,
      restored_session_id: pins.restored.sessionId,
    }),
  );
  expect(audit.baseline).toEqual(pins.baseline);
  expect(audit.adopted).toEqual(pins.adopted);
  expect(audit.restored).toEqual(pins.restored);
  return audit.outcomes;
}

export async function captureQualificationEvidence(
  page: Page,
  info: TestInfo,
  name: string,
  region: Locator,
) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const directory = process.env.WALLIE_FACTORY_IMPROVEMENT_PROOF_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `${name}.png`);
  await region.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    style: '[data-shell-header], a[href="#main-content"] { visibility: hidden !important; }',
  });
  await info.attach(name, { path, contentType: "image/png" });
}
