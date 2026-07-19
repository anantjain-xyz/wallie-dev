#!/usr/bin/env node
/**
 * Intentionally introduce one defect per gate, assert failure, then revert.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env, CI: "1" },
    encoding: "utf8",
    stdio: "inherit",
  });
  return result.status ?? 1;
}

function mustFail(label, command, args) {
  const status = run(command, args);
  if (status === 0) throw new Error(`${label} was expected to fail but passed`);
  console.log(`✓ ${label} failed as expected`);
}

function mustPass(label, command, args) {
  const status = run(command, args);
  if (status !== 0) throw new Error(`${label} was expected to pass but failed`);
  console.log(`✓ ${label} passed`);
}

function withTemporaryEdit(filePath, mutate, work) {
  const absolute = resolve(root, filePath);
  if (!existsSync(absolute)) throw new Error(`Missing ${filePath}`);
  const original = readFileSync(absolute, "utf8");
  try {
    writeFileSync(absolute, mutate(original));
    return work();
  } finally {
    writeFileSync(absolute, original);
  }
}

console.log("Building once before gate proofs…");
mustPass("initial build", "pnpm", ["build"]);

withTemporaryEdit(
  "e2e/helpers/axe.ts",
  (source) =>
    source.replace(
      "expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);",
      'expect([{ id: "intentional-a11y", impact: "critical", help: "proof", nodes: 1 }]).toEqual([]);',
    ),
  () => {
    mustFail("accessibility gate", "pnpm", [
      "exec",
      "playwright",
      "test",
      "e2e/regression/status-forced-colors.spec.ts",
      "-g",
      "statuses remain distinguishable",
    ]);
  },
);

withTemporaryEdit(
  "e2e/helpers/overflow.ts",
  (source) =>
    source.replace(
      "expect(contract.rootOverflowX).toBeLessThanOrEqual(1);",
      "expect(contract.rootOverflowX).toBeLessThanOrEqual(-1);",
    ),
  () => {
    mustFail("overflow gate", "pnpm", [
      "exec",
      "playwright",
      "test",
      "e2e/regression/state-fixtures.spec.ts",
      "-g",
      "empty through complete",
    ]);
  },
);

withTemporaryEdit(
  "src/components/landing/landing-page.tsx",
  (source) => {
    if (!/Wallie|wallie/.test(source)) {
      throw new Error("Landing page did not contain expected brand copy for screenshot proof");
    }
    return source.replace(/Wallie/g, "WalliePROOF").replace(/wallie/g, "walliePROOF");
  },
  () => {
    mustPass("rebuild after screenshot defect", "pnpm", ["build"]);
    mustFail("screenshot gate", "pnpm", [
      "exec",
      "playwright",
      "test",
      "e2e/regression/visual-matrix.spec.ts",
    ]);
  },
);

withTemporaryEdit(
  "config/route-budgets.json",
  (source) => {
    const json = JSON.parse(source);
    for (const key of Object.keys(json)) json[key] = 1;
    return `${JSON.stringify(json, null, 2)}\n`;
  },
  () => {
    mustFail("bundle budget gate", "pnpm", ["check:route-budgets"]);
  },
);

console.log("All regression gates failed on intentional defects and were reverted.");
