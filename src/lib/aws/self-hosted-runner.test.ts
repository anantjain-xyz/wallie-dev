import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type Call = { command: string; args: string[]; context?: string; host?: string };

function run(endpoint: string, dockerEnv: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "wallie-qualification-runner-test-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const scripts = join(directory, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts);
  mkdirSync(join(directory, "infra", "supabase"), { recursive: true });
  cpSync(join(root, "scripts", "check-self-hosted-supabase.mjs"), join(scripts, "check.mjs"));
  cpSync(join(root, "scripts", "fixtures"), join(scripts, "fixtures"), { recursive: true });
  cpSync(
    join(root, "infra", "supabase", "upstream.lock.json"),
    join(directory, "infra", "supabase", "upstream.lock.json"),
  );
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  const log = join(directory, "calls.jsonl");
  writeFileSync(log, "");
  const tool = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_TOOL_LOG, JSON.stringify({
  command, args, context: process.env.DOCKER_CONTEXT, host: process.env.DOCKER_HOST
}) + "\\n");
if (command === "docker") {
  if (args[0] === "context" && args[1] === "inspect") {
    process.stdout.write(process.env.TEST_DOCKER_ENDPOINT + "\\n");
    process.exit(0);
  }
  // Stop before Compose can perform any operation. No real Docker is on PATH.
  process.exit(91);
}
// A valid local endpoint may advance to Git, where this fixture stops safely.
process.exit(92);
`;
  for (const command of ["docker", "git"]) writeFileSync(join(bin, command), tool, { mode: 0o700 });
  const result = spawnSync(process.execPath, [join(scripts, "check.mjs")], {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      NODE_ENV: "test",
      PATH: bin,
      HOME: directory,
      TEST_TOOL_LOG: log,
      TEST_DOCKER_ENDPOINT: endpoint,
      ...dockerEnv,
    },
  });
  if (result.error) throw result.error;
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call);
  return { ...result, calls };
}

describe("self-hosted qualification Docker isolation", () => {
  it("rejects a remote context even when DOCKER_HOST names a local socket", () => {
    const result = run("ssh://remote.example", {
      DOCKER_CONTEXT: "remote-context",
      DOCKER_HOST: "unix:///local.sock",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a local Docker daemon");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].args).toEqual([
      "context",
      "inspect",
      "remote-context",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]);
  });

  it("rejects a remote DOCKER_HOST without inspecting the default context", () => {
    const result = run("unix:///local.sock", { DOCKER_HOST: "tcp://remote.example:2376" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a local Docker daemon");
    expect(result.calls).toEqual([]);
  });

  it("rejects a remote default context before fetching upstream", () => {
    const result = run("ssh://remote.example");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires a local Docker daemon");
    expect(result.calls.map((call) => call.command)).toEqual(["docker"]);
  });

  it.each<Record<string, string>>([
    { DOCKER_CONTEXT: "local-context", DOCKER_HOST: "ssh://remote.example" },
    { DOCKER_HOST: "unix:///local.sock" },
    {},
  ])("allows the selected local socket past preflight: %j", (dockerEnv) => {
    const result = run("unix:///local.sock", dockerEnv);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("git failed (92)");
    expect(result.calls.at(-1)?.command).toBe("git");
    expect(result.calls.at(-1)?.args[0]).toBe("clone");
    expect(result.calls.some((call) => call.args.includes("compose"))).toBe(false);
    expect(result.stdout).not.toContain("PASS");
  });
});
