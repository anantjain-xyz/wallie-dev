import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

import {
  runArtifactAvailabilitySchema,
  runArtifactKindSchema,
} from "../src/features/wallie/run-artifacts-contracts";
import { runTranscriptBodySchema } from "../src/features/wallie/run-transcript-contracts";
import { signInViaMagicLink } from "./helpers/auth";

const loopback = z
  .string()
  .url()
  .refine(
    (value) =>
      URL.canParse(value) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname),
  );
const environment = z.object({
  NEXT_PUBLIC_SUPABASE_URL: loopback,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  WALLIE_CONTINUITY_DB_URL: loopback,
});

const identifier = z.string().uuid();
const positiveInteger = z.number().int().positive();
const readySchema = z.object({
  workspaceId: identifier,
  workspaceSlug: z.string().regex(/^[a-z0-9-]+$/),
  userEmail: z.string().email(),
  sessionId: identifier,
  sessionNumber: positiveInteger,
  runId: identifier,
  attemptCount: positiveInteger,
  stageSlug: z.string().min(1),
  initialText: z.string().min(1),
  reconnectText: z.string().min(1),
  terminalText: z.string().min(1),
});
const completeSchema = z.object({
  artifactId: identifier,
  artifactVersion: positiveInteger,
  runId: identifier,
  checkpointSha: z.string().regex(/^[0-9a-f]{40}$/),
  workerPid: positiveInteger,
});
const transcriptSchema = z.object({
  runId: identifier,
  runStatus: z.string(),
  attemptCount: positiveInteger,
  mode: z.literal("events"),
  entries: z.array(runTranscriptBodySchema),
});
const artifactCatalogSchema = z.object({
  items: z.array(
    z.object({
      id: identifier,
      kind: runArtifactKindSchema,
      availability: runArtifactAvailabilitySchema,
      digest: z.object({ algorithm: z.string(), value: z.string() }).nullable(),
      producer: z.object({
        runId: identifier,
        sessionId: identifier,
        attemptCount: positiveInteger,
      }),
      checkpoint: z.object({ runId: identifier, commitSha: z.string() }).nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

type FixtureEnvironment = z.infer<typeof environment>;

function startFixture(directory: string, config: FixtureEnvironment) {
  const processGroup = process.platform !== "win32";
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/check-continuity.ts"], {
    detached: processGroup,
    env: {
      ...process.env,
      WALLIE_CONTINUITY_SUPABASE_URL: config.NEXT_PUBLIC_SUPABASE_URL,
      WALLIE_CONTINUITY_SERVICE_ROLE_KEY: config.SUPABASE_SECRET_KEY,
      WALLIE_CONTINUITY_DB_URL: config.WALLIE_CONTINUITY_DB_URL,
      WALLIE_RUN_HISTORY_BROWSER_HANDSHAKE_DIR: directory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let exited = false;
  const log = (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-12_000);
  };
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  const finished = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      exited = true;
      log(Buffer.from(error.message));
      resolve(null);
    });
    child.once("close", (code) => {
      exited = true;
      resolve(code);
    });
  });
  const failure = (message: string) =>
    new Error(
      `${message}\n${logs.replaceAll(config.SUPABASE_SECRET_KEY, "[redacted]").replaceAll(config.WALLIE_CONTINUITY_DB_URL, "[redacted]")}`,
    );
  const mark = (name: string) => writeFile(join(directory, name), "", { mode: 0o600 });
  async function waitFor(name: string) {
    await expect
      .poll(
        () => {
          if (exited) throw failure(`Continuity fixture exited before ${name}.`);
          return existsSync(join(directory, name));
        },
        { timeout: 60_000, message: `Wait for continuity fixture ${name}` },
      )
      .toBe(true);
  }

  return {
    async read<T>(name: string, schema: z.ZodType<T>): Promise<T> {
      await waitFor(name);
      return schema.parse(JSON.parse(await readFile(join(directory, name), "utf8")));
    },
    waitFor,
    mark,
    async verifyExit() {
      if ((await finished) !== 0) throw failure("Continuity fixture failed.");
    },
    async close() {
      if (exited) return;
      await mark("browser-aborted");
      const grace = AbortSignal.timeout(5_000);
      await Promise.race([
        finished,
        new Promise<void>((resolve) =>
          grace.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (!exited && child.pid) {
        // The launcher owns Vitest and its worker subprocesses.
        try {
          process.kill(processGroup ? -child.pid : child.pid, "SIGTERM");
        } catch (error) {
          if (!(typeof error === "object" && error && "code" in error && error.code === "ESRCH")) {
            throw error;
          }
        }
        await finished;
      }
    },
  };
}

function nextForwardPage(page: Page, transcriptPath: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.ok() &&
      url.pathname === transcriptPath &&
      url.searchParams.get("direction") === "newer"
    );
  });
}

test("reopens an exact retained run after browser closure and worker restart", async ({
  baseURL,
  browser,
  context,
  page,
}) => {
  test.skip(
    process.env.WALLIE_RUN_HISTORY_BROWSER !== "1",
    "Requires the isolated run-history fixture",
  );
  test.setTimeout(180_000);
  const config = environment.safeParse(process.env);
  const origin = loopback.safeParse(baseURL);
  if (!config.success || !origin.success) {
    throw new Error(
      "The run-history browser fixture requires a loopback app, disposable Supabase API and database URLs, and local Supabase keys.",
    );
  }

  const directory = await mkdtemp(join(tmpdir(), "wallie-run-history-browser-"));
  const fixture = startFixture(directory, config.data);
  let reopened: BrowserContext | undefined;

  try {
    const run = await fixture.read("run-ready.json", readySchema);
    const workspacePath = `/w/${run.workspaceSlug}`;
    const runPath = `${workspacePath}/runs/${run.runId}`;
    const api = `/api/workspaces/${run.workspaceId}/runs/${run.runId}`;
    const transcriptPath = `${api}/transcript`;

    await test.step("Miss a live event while offline and recover it by cursor", async () => {
      await Promise.all([
        nextForwardPage(page, transcriptPath),
        signInViaMagicLink(page, runPath, { baseURL: origin.data, email: run.userEmail }),
      ]);
      const activity = page.getByRole("list", { name: "Run activity" });
      await expect(activity.getByText(run.initialText, { exact: true })).toHaveCount(1);
      await expect(
        page.getByText("This attempt has no accepted artifact.", { exact: true }),
      ).toBeVisible();

      await context.setOffline(true);
      await expect(
        page.getByText("You’re offline. Showing saved progress.", { exact: true }),
      ).toBeVisible();
      await fixture.mark("browser-offline");
      await fixture.waitFor("run-update");
      await expect(activity.getByText(run.reconnectText, { exact: true })).toHaveCount(0);

      const [caughtUp] = await Promise.all([
        nextForwardPage(page, transcriptPath),
        context.setOffline(false),
      ]);
      const next = transcriptSchema.parse(await caughtUp.json());
      expect(next).toMatchObject({ runId: run.runId, attemptCount: run.attemptCount });
      expect(
        next.entries.filter(
          (entry) =>
            (entry.kind === "text" || entry.kind === "progress") &&
            entry.payload.text === run.reconnectText,
        ),
      ).toHaveLength(1);
      await expect(activity.getByText(run.initialText, { exact: true })).toHaveCount(1);
      await expect(activity.getByText(run.reconnectText, { exact: true })).toHaveCount(1);
    });

    const storageState = await context.storageState();
    await context.close();
    await fixture.mark("browser-closed");
    const accepted = await fixture.read("run-complete.json", completeSchema);
    expect(accepted.runId).toBe(run.runId);
    reopened = await browser.newContext({ baseURL, storageState });
    const inspected = await reopened.newPage();

    await test.step("Inspect the same run and its accepted evidence after the restart", async () => {
      await inspected.goto(`${workspacePath}/runs`);
      const exactRun = inspected
        .getByRole("list", { name: "Runs" })
        .getByRole("link", { name: /^Inspect run for session / })
        .and(inspected.locator(`a[href="${runPath}"]`));
      await expect(exactRun).toHaveCount(1);
      await exactRun.click();
      await expect(
        inspected.getByText("This attempt completed successfully.", { exact: true }),
      ).toBeVisible();
      const activity = inspected.getByRole("list", { name: "Run activity" });
      for (const label of [run.initialText, run.reconnectText, "Completion", "Capture ended"]) {
        await expect(activity.getByText(label, { exact: true })).toHaveCount(1);
      }

      const durable = await inspected.request.get(transcriptPath);
      expect(durable.ok()).toBe(true);
      const terminal = transcriptSchema.parse(await durable.json());
      expect(terminal).toMatchObject({
        runId: run.runId,
        attemptCount: run.attemptCount,
        runStatus: "success",
      });
      const outcomes = terminal.entries.filter((entry) => entry.kind === "terminal");
      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0];
      if (outcome?.payload.status !== "completed" || !outcome.payload.finalOutput) {
        throw new Error("The terminal event did not retain the completed Markdown.");
      }
      expect(outcome.payload.summary).toBe(run.terminalText);

      const list = await inspected.request.get(`${api}/artifacts`);
      expect(list.ok()).toBe(true);
      const catalog = artifactCatalogSchema.parse(await list.json());
      expect(catalog.nextCursor).toBeNull();
      const producer = {
        runId: run.runId,
        sessionId: run.sessionId,
        attemptCount: run.attemptCount,
      };
      const checkpoint = { runId: run.runId, commitSha: accepted.checkpointSha };
      expect(catalog.items.filter((entry) => entry.kind === "checkpoint")).toEqual([
        expect.objectContaining({ id: run.runId, availability: "retained", producer, checkpoint }),
      ]);
      const markdown = catalog.items.filter((entry) => entry.kind === "stage_markdown");
      expect(markdown).toEqual([
        expect.objectContaining({
          id: accepted.artifactId,
          availability: "available",
          producer,
          checkpoint,
        }),
      ]);
      const download = await inspected.request.get(
        `${api}/artifacts/stage_markdown/${accepted.artifactId}?download=1`,
      );
      expect(download.ok()).toBe(true);
      const bytes = await download.body();
      expect(markdown[0]?.digest).toEqual({
        algorithm: "sha256",
        value: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(bytes.toString()).toBe(outcome.payload.finalOutput);

      const link = inspected.getByRole("link", { name: "Open artifact", exact: true });
      await expect(link).toHaveCount(1);
      await link.click();
      await expect(inspected).toHaveURL(
        (url) =>
          url.pathname === `${workspacePath}/sessions/${run.sessionNumber}` &&
          url.searchParams.get("artifactId") === accepted.artifactId &&
          url.searchParams.get("artifactStage") === run.stageSlug &&
          url.searchParams.get("artifactVersion") === String(accepted.artifactVersion),
      );
      await inspected.getByRole("button", { name: "Inspect artifact provenance" }).click();
      await expect(inspected.getByText(accepted.artifactId, { exact: true })).toBeVisible();
      const checkpointCommit = inspected
        .locator("dl > div")
        .filter({ has: inspected.getByText("Checkpoint commit", { exact: true }) })
        .locator("dd");
      await expect(checkpointCommit).toHaveText(accepted.checkpointSha);
    });

    await fixture.mark("browser-verified");
    await fixture.verifyExit();
  } finally {
    await reopened?.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
