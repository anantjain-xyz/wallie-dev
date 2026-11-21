import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createServerClient } from "@supabase/ssr";
import { chromium, type Locator, type Page } from "playwright-core";

import {
  benchmarkComparisonExportManifestSchema,
  benchmarkComparisonExportReceiptSchema,
} from "@/lib/factory-benchmarks/comparison-contracts";
import type { Database } from "@/lib/supabase/database.types";

import {
  qualificationAcceptance,
  qualificationSuite,
  type QualificationWitness,
} from "./factory-benchmark-qualification";

function loopbackOrigin(raw: string) {
  const url = new URL(raw);
  assert(
    url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password,
  );
  return url.origin;
}

async function download(page: Page, locator: Locator, directory: string) {
  const wait = page.waitForEvent("download");
  await locator.click();
  const artifact = await wait;
  const path = join(directory, artifact.suggestedFilename());
  await artifact.saveAs(path);
  return readFile(path, "utf8");
}

export async function browseBenchmarkQualification(input: {
  witness: QualificationWitness;
  workspaceSlug: string;
  appUrl: string;
  supabaseUrl: string;
  publishableKey: string;
  password: string;
  proofDir: string;
}) {
  const app = loopbackOrigin(input.appUrl);
  const supabase = loopbackOrigin(input.supabaseUrl);
  const { witness } = input;
  await mkdir(input.proofDir, { recursive: true, mode: 0o700 });
  const cookies = new Map<string, string>();
  const client = createServerClient<Database>(supabase, input.publishableKey, {
    cookies: {
      getAll: () => Array.from(cookies, ([name, value]) => ({ name, value })),
      setAll: (values) => values.forEach(({ name, value }) => cookies.set(name, value)),
    },
  });
  const signedIn = await client.auth.signInWithPassword({
    email: witness.ownerEmail,
    password: input.password,
  });
  assert(signedIn.data.user && cookies.size, "The benchmark review account must sign in.");
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
  try {
    const context = await browser.newContext({
      baseURL: app,
      acceptDownloads: true,
      viewport: { width: 1440, height: 1050 },
      reducedMotion: "reduce",
      colorScheme: "light",
    });
    await context.route("**/*", async (route) => {
      const origin = new URL(route.request().url()).origin;
      if (origin === app || origin === supabase) await route.continue();
      else await route.abort();
    });
    await context.addCookies(Array.from(cookies, ([name, value]) => ({ name, value, url: app })));
    const page = await context.newPage();
    page.setDefaultTimeout(25_000);
    page.setDefaultNavigationTimeout(45_000);
    const comparison = `/w/${input.workspaceSlug}/benchmarks/${witness.suiteId}/comparisons/${witness.experimentId}`;
    const query = `?factory=${witness.factoryId}`;
    assert.equal(
      (await page.goto(comparison + query, { waitUntil: "domcontentloaded" }))?.status(),
      200,
    );
    await page.getByRole("heading", { name: "Comparison results" }).waitFor();
    await page.getByText(new RegExp(qualificationSuite + " · Revision")).waitFor();
    const rows = page.getByRole("table", { name: "Frozen trials" }).locator("tbody tr");
    assert.equal(await rows.count(), 8);
    for (const [status, count] of [
      ["Completed", 1],
      ["Failed", 2],
      ["Canceled", 1],
      ["Excluded", 4],
    ] as const) {
      assert.equal(await rows.getByText(status, { exact: true }).count(), count);
    }
    await page
      .getByText(/3 trials have unavailable cost/)
      .first()
      .waitFor();
    await page.getByText("Spend breakdown", { exact: true }).first().click();
    await page
      .getByText(/\$0\.375 reserved, including \$0\.375 held/)
      .first()
      .waitFor();
    const evidenceLink = rows.locator(`a[href*="/trials/${witness.nodeTrialId}"]`);
    assert.equal(await evidenceLink.count(), 1);
    await page.screenshot({ path: join(input.proofDir, "comparison.png"), animations: "disabled" });
    await evidenceLink.click();
    await page.waitForURL(new RegExp("/trials/" + witness.nodeTrialId));
    await page.getByText(qualificationAcceptance, { exact: true }).waitFor();
    await page.getByText(witness.archivedCommit, { exact: true }).first().waitFor();
    const diff = page.getByLabel("Unified diff for this trial output");
    await diff.waitFor();
    assert.match(await diff.innerText(), /[.]wallie-benchmark-result[.]json/);
    await page
      .getByRole("heading", { name: "Output diff", exact: true })
      .locator("xpath=ancestor::section[1]")
      .screenshot({ path: join(input.proofDir, "trial-evidence.png"), animations: "disabled" });
    assert.equal(
      (
        await page.request.get(
          comparison + "/trials/" + witness.nodeTrialId + `?factory=${witness.siblingFactoryId}`,
        )
      ).status(),
      404,
    );
    const exportsPath = `/api/workspaces/${witness.workspaceId}/factories/${witness.factoryId}/benchmarks/experiments/${witness.experimentId}/exports`;
    const created = await context.request.post(exportsPath, {
      headers: { origin: app },
      data: { requestId: randomUUID() },
      timeout: 45_000,
    });
    assert.equal(created.status(), 201, await created.text());
    const exported = benchmarkComparisonExportReceiptSchema.parse(await created.json());
    await page.goto(comparison + query, { waitUntil: "domcontentloaded" });
    const recent = page
      .getByRole("list", { name: "Result export history" })
      .getByRole("listitem")
      .filter({ has: page.locator(`a[href$="/${exported.exportId}"]`) });
    const manifestLink = recent.getByRole("link", { name: /^Download result manifest/ });
    const body = await download(page, manifestLink, input.proofDir);
    const manifest = benchmarkComparisonExportManifestSchema.parse(JSON.parse(body));
    assert.deepEqual(manifest.trialIds, witness.frozenTrialIds);
    await recent.getByText(/^Trial rows · /).click();
    for (const part of manifest.pages) {
      await download(
        page,
        recent.getByRole("link", { name: `Download trial part ${part.ordinal}` }),
        input.proofDir,
      );
    }
    await recent.getByText(/^Configuration rows · /).click();
    for (const part of manifest.candidatePages) {
      await download(
        page,
        recent.getByRole("link", { name: `Download configuration part ${part.ordinal}` }),
        input.proofDir,
      );
    }
    const downloadHref = await manifestLink.getAttribute("href");
    assert(downloadHref);
    const fetched = await page.request.get(downloadHref);
    assert.equal(fetched.headers()["cache-control"], "private, no-store");
    assert.equal(await fetched.text(), body);
  } finally {
    await browser.close();
  }
}
