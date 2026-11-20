import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { createGitHubResourceReader } from "@/lib/factory-context/github-source";
import { readFactoryJudgeCodeDiff } from "@/lib/factory-evaluations/exact-diff";
import { runFactoryJudge } from "@/lib/factory-evaluations/judge";
import { loadFactoryJudgeEvidence } from "@/lib/factory-evaluations/judge-evidence";
import type { FactoryJudgeClaim } from "@/lib/factory-evaluations/judge-inputs";
import type { Database } from "@/lib/supabase/database.types";

import { factoryScorerPresets } from "./presets";

vi.mock("@/lib/factory-context/github-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/factory-context/github-source")>()),
  createGitHubResourceReader: vi.fn(),
}));

type Files = Readonly<Record<string, string | Uint8Array>>;
type CalibrationCase = {
  name: string;
  base: Files;
  changes: Files;
} & (
  | {
      expected: "pass" | "fail";
      score: boolean;
      explanation: string;
      citedLines: readonly string[];
      proof: { tests: string[]; testOnBase: string; baseExit: 0 | 1 };
    }
  | { expected: "inconclusive"; score: null; explanation: string }
);

const capacity = "export const canReserveSlot = (active, limit) => active < limit;\n";
const saturationTest = `import assert from "node:assert/strict";
import { test } from "node:test";
import { canReserveSlot } from "./capacity.mjs";

test("the last slot is exclusive", () => {
  assert.equal(canReserveSlot(1, 1), false);
});
`;
const duplicateTest = `${saturationTest}
test("a full queue refuses another claim", () => {
  assert.equal(canReserveSlot(1, 1), false);
});
`;
const testWithUnusedScaffold = `import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { canReserveSlot } from "./capacity.mjs";

const unusedFixture = mkdtempSync(join(tmpdir(), "slot-scaffold-"));
after(() => rmSync(unusedFixture, { recursive: true, force: true }));

test("the last slot is exclusive", () => {
  assert.equal(canReserveSlot(1, 1), false);
});
`;

const reviewedCorpus: CalibrationCase[] = [
  {
    name: "keeps a boundary regression test that fails against the previous implementation",
    base: { "capacity.mjs": capacity.replace("active < limit", "active <= limit") },
    changes: { "capacity.mjs": capacity, "capacity.test.mjs": saturationTest },
    expected: "pass",
    score: true,
    explanation:
      "The boundary assertion directly covers the saturation behavior this change fixes.",
    citedLines: [`+${capacity.trimEnd()}`, "+  assert.equal(canReserveSlot(1, 1), false);"],
    proof: { tests: ["capacity.test.mjs"], testOnBase: "capacity.test.mjs", baseExit: 1 },
  },
  {
    name: "flags a duplicate capacity assertion when the existing coverage is visible in the diff",
    base: { "capacity.mjs": capacity, "capacity.test.mjs": saturationTest },
    changes: { "capacity.test.mjs": duplicateTest },
    expected: "fail",
    score: false,
    explanation: "The test added below the existing case repeats its exact capacity assertion.",
    citedLines: [
      "   assert.equal(canReserveSlot(1, 1), false);",
      "+  assert.equal(canReserveSlot(1, 1), false);",
    ],
    proof: { tests: ["capacity.test.mjs"], testOnBase: "capacity.test.mjs", baseExit: 0 },
  },
  {
    name: "flags unused scaffolding in an otherwise useful regression test",
    base: {
      "capacity.mjs": capacity.replace("active < limit", "active <= limit"),
    },
    changes: {
      "capacity.mjs": capacity,
      "capacity.test.mjs": testWithUnusedScaffold,
    },
    expected: "fail",
    score: false,
    explanation:
      "The boundary test covers a real regression. Its temporary directory is only created and removed, and the assertion never uses it.",
    citedLines: [
      '+const unusedFixture = mkdtempSync(join(tmpdir(), "slot-scaffold-"));',
      "+after(() => rmSync(unusedFixture, { recursive: true, force: true }));",
      "+  assert.equal(canReserveSlot(1, 1), false);",
    ],
    proof: { tests: ["capacity.test.mjs"], testOnBase: "capacity.test.mjs", baseExit: 1 },
  },
  {
    name: "abstains when a snapshot delta provides no evidence of what it verifies",
    base: { "render.snap": '{"actions":3,"width":620}\n' },
    changes: { "render.snap": '{"actions":4,"width":640}\n' },
    expected: "inconclusive",
    score: null,
    explanation:
      "The snapshot values changed, but the diff does not identify the behavior or assertions that generate them.",
  },
];

function writeFiles(directory: string, files: Files) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function git(directory: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.name=Calibration Fixture", "-c", "user.email=fixture@example.test", ...args],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      timeout: 3_000,
    },
  );
}

type ComparisonSource = Parameters<typeof readFactoryJudgeCodeDiff>[0];

async function withNativeCheckout(
  base: Files,
  changes: Files,
  check: (directory: string, source: ComparisonSource) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "wallie-scorer-calibration-"));
  try {
    git(directory, "init", "--quiet", "--template=", "--object-format=sha1");
    writeFiles(directory, base);
    git(directory, "add", "--all");
    git(directory, "commit", "--quiet", "--no-gpg-sign", "-m", "Baseline");
    const inputSha = git(directory, "rev-parse", "HEAD").trim();
    writeFiles(directory, changes);
    git(directory, "add", "--all");
    git(directory, "commit", "--quiet", "--no-gpg-sign", "-m", "Candidate");
    const outputSha = git(directory, "rev-parse", "HEAD").trim();
    const files = git(directory, "diff", "--no-renames", "--numstat", inputSha, outputSha)
      .trimEnd()
      .split("\n")
      .map((line) => {
        const [additions, deletions, filename] = line.split("\t");
        const patchText = git(
          directory,
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          inputSha,
          outputSha,
          "--",
          filename,
        );
        const firstHunk = patchText.indexOf("\n@@ ");
        return {
          filename,
          status: Object.hasOwn(base, filename) ? "modified" : "added",
          additions: additions === "-" ? 0 : Number(additions),
          deletions: deletions === "-" ? 0 : Number(deletions),
          patch: firstHunk < 0 ? undefined : patchText.slice(firstHunk + 1).replace(/\n$/, ""),
        };
      });
    const read = vi.fn().mockResolvedValue(
      Buffer.from(
        JSON.stringify({
          status: "ahead",
          base_commit: { sha: inputSha },
          merge_base_commit: { sha: inputSha },
          total_commits: 1,
          commits: [{ sha: outputSha }],
          files,
        }),
      ),
    );
    vi.mocked(createGitHubResourceReader).mockResolvedValueOnce(read);
    await check(directory, {
      installationId: 1,
      repositoryId: 25,
      repositoryFullName: "fixture/calibration",
      inputSha,
      outputSha,
    });
    expect(read).toHaveBeenCalledExactlyOnceWith(`compare/${inputSha}...${outputSha}`, 512 * 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runTests(directory: string, files: string[]) {
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
    cwd: directory,
    encoding: "utf8",
    timeout: 3_000,
  });
  if (run.error) throw run.error;
  return run;
}

function proveBaseAndCandidate(directory: string, inputSha: string, fixture: CalibrationCase) {
  if (fixture.expected === "inconclusive") return;

  const { tests, testOnBase, baseExit } = fixture.proof;
  expect(runTests(directory, tests).status).toBe(0);
  git(directory, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", inputSha);
  for (const path of tests) {
    if (Object.hasOwn(fixture.base, path)) expect(runTests(directory, [path]).status).toBe(0);
  }
  writeFiles(directory, { [testOnBase]: fixture.changes[testOnBase] });
  const baseline = runTests(directory, [testOnBase]);
  expect(baseline.status).toBe(baseExit);
  if (baseExit === 1) {
    expect(baseline.stdout).toContain("not ok 1 - the last slot is exclusive");
    expect(baseline.stdout).toContain("true !== false");
  }
}

const profile = {
  model: "openai/gpt-4.1-mini",
  provider: "openai",
  allowImage: false,
  allowVideo: false,
};
const id = (slot: number) => `60700000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const reference = { kind: "code_diff", id: id(1) } as const;

it.each(reviewedCorpus)("$name", async (fixture) => {
  await withNativeCheckout(fixture.base, fixture.changes, async (directory, source) => {
    proveBaseAndCandidate(directory, source.inputSha, fixture);
    const signal = new AbortController().signal;
    const diff = await readFactoryJudgeCodeDiff(source, signal);
    if (diff.status !== "available") throw new Error(`Calibration diff was ${diff.status}.`);

    // Keep human-reviewed expectations independent of the outbound judge call.
    // The provider fixture proves the verdict and citation contract locally.
    const lines = diff.text.split("\n");
    const markers = fixture.expected === "inconclusive" ? [] : fixture.citedLines;
    const numbered = markers.map((line) => lines.indexOf(line) + 1);
    expect(numbered.every((line) => line > 0)).toBe(true);
    const citations = numbered.length
      ? [{ ...reference, start: Math.min(...numbered), end: Math.max(...numbered) }]
      : [];
    const definition = factoryScorerPresets["redundant-tests"].definition;
    const fetcher = vi.fn<typeof fetch>(async (_url, request) => {
      expect(request?.body).toContain(JSON.stringify(diff.text).slice(1, -1));
      return Response.json({
        model: profile.model,
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                score: fixture.score,
                explanation: fixture.explanation,
                citations,
              }),
            },
          },
        ],
      });
    });
    const outcome = await runFactoryJudge({
      definition,
      evidence: [{ reference, mediaType: "text/plain", text: diff.text }],
      profile,
      apiKey: "fixture-calibration-only",
      signal,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(outcome.explanation).toBe(fixture.explanation);
    expect(outcome.result).toMatchObject({ status: fixture.expected, evidence: [reference] });
    expect(outcome.locations).toEqual(
      citations.map(({ start, end }) => ({
        reference,
        location: { kind: "lines", startLine: start, endLine: end },
      })),
    );
    if (fixture.expected === "inconclusive") {
      expect(outcome.result).toMatchObject({ reason: "ambiguous_evidence" });
      expect(outcome.result).not.toHaveProperty("score");
    } else {
      expect(outcome.result).toMatchObject({ score: { kind: "boolean", value: fixture.score } });
    }
  });
});

it("treats a native binary delta with no text hunk as unsupported evidence", async () => {
  const base = { "recording.bin": Uint8Array.from([0, 1, 2]) };
  const changes = { "recording.bin": Uint8Array.from([0, 2, 3]) };
  await withNativeCheckout(base, changes, async (_directory, source) => {
    const claim: FactoryJudgeClaim = {
      workspace_id: id(2),
      factory_id: id(3),
      job_id: id(4),
      session_id: id(5),
      run_id: reference.id,
      scorer_revision_id: id(6),
      sample_receipt_id: id(7),
      target_commit_sha: source.outputSha,
      attempt_id: id(8),
      attempt_number: 1,
      lease_id: id(9),
      lease_expires_at: "2026-11-20T00:00:00Z",
    };
    const fetcher = vi.fn<typeof fetch>();
    const client = createClient<Database>("https://calibration.example.test", "fixture", {
      auth: { persistSession: false },
      global: { fetch: fetcher },
    });
    const result = await loadFactoryJudgeEvidence(
      client,
      claim,
      [
        {
          ...reference,
          input_sha: source.inputSha,
          output_sha: source.outputSha,
          repository_id: id(10),
          repository_full_name: source.repositoryFullName,
          github_repository_id: source.repositoryId,
          installation_id: source.installationId,
        },
      ],
      factoryScorerPresets["redundant-tests"].definition.rubric,
      new AbortController().signal,
    );
    expect(result).toEqual({ status: "unsupported_evidence" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
