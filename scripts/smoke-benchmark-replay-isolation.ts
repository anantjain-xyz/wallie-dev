import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { isIPv4 } from "node:net";

import {
  createBenchmarkReplaySandbox,
  hasRecoverableSandboxSource,
  sealBenchmarkReplaySandbox,
  stopSandboxById,
  type SandboxConnection,
} from "../src/lib/sandbox";

const repositoryUrl = "https://github.com/anantjain-xyz/wallie-dev.git";
const fixture = "The sealed replay can still read recorded inputs.\n";
const fixturePath = "/tmp/wallie-benchmark-isolation/recorded-input.txt";
const probe = String.raw`
  const assert = require("node:assert/strict");
  const { execFile } = require("node:child_process");
  const { Resolver } = require("node:dns/promises");
  const { readFile } = require("node:fs/promises");
  const { createHash } = require("node:crypto");
  const { connect } = require("node:tls");
  const { promisify } = require("node:util");

  const [repository, address, fixturePath] = process.argv.slice(1);
  const { hostname } = new URL(repository);
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  const git = () => promisify(execFile)(
    "git", ["-c", "http.followRedirects=false", "ls-remote", "--exit-code", repository, "HEAD"],
    {
      timeout: 6000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    },
  );
  const https = () => fetch(new URL("/robots.txt", repository), {
    method: "HEAD", redirect: "error", signal: AbortSignal.timeout(6000),
  });
  const tls = (ip) => new Promise((resolve, reject) => {
    const socket = connect({ host: ip, port: 443, servername: hostname });
    socket.setTimeout(6000, () => socket.destroy(new Error("TLS timed out")));
    socket.on("error", reject);
    socket.on("secureConnect", () => {
      resolve();
      socket.end();
    });
  });

  async function main() {
    if (address === undefined) {
      const [[ip], response, { stdout }] = await Promise.all([
        resolver.resolve4(hostname), https(), git(),
      ]);
      assert.ok(response.ok);
      assert.match(stdout, /^[0-9a-f]{40}\s+HEAD\s*$/);
      await tls(ip);
      process.stdout.write(ip);
      return;
    }
    const probes = { dns: resolver.resolve4(hostname), https: https(), git: git(), directIp: tls(address) };
    const results = await Promise.all(Object.entries(probes).map(async ([name, request]) => {
      const blocked = await request.then(() => false, () => true);
      assert.ok(blocked, name + " reached the public read canary after sealing");
      return name;
    }));
    const digest = createHash("sha256").update(await readFile(fixturePath)).digest("hex");
    process.stdout.write(JSON.stringify({ denied: results, digest }));
  }
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
`;

async function main() {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = process.env;
  if (!token || !teamId || !projectId)
    throw new Error("The documented Vercel smoke credentials are required.");
  const connection: SandboxConnection = {
    provider: "vercel",
    revision: "benchmark-replay-isolation-smoke",
    credentials: { token, teamId, projectId },
  };
  const signal = AbortSignal.timeout(120_000);
  const ownerId = randomUUID();
  let sandboxId: string | undefined;
  let evidence: { denied: string[]; digest: string } | undefined;
  try {
    const sandbox = await createBenchmarkReplaySandbox(
      {
        workspaceId: ownerId,
        ownerId,
        timeoutMs: 100_000,
        signal,
        onSandboxCreated: async ({ sandboxId: id }) => {
          sandboxId = id;
        },
      },
      connection,
    );
    const bootstrap = await sandbox.exec("node", ["-e", probe, repositoryUrl], { signal });
    const bootstrapStatus = await bootstrap.exitCode;
    const { stdout: address, stderr: bootstrapError } = await bootstrap.output();
    assert.equal(
      bootstrapStatus,
      0,
      `Public read canary failed during bootstrap: ${bootstrapError}`,
    );
    assert.ok(isIPv4(address));

    await sandbox.writeFile(fixturePath, fixture, { mode: 0o600 });
    await sealBenchmarkReplaySandbox(sandbox, signal);
    await assert.rejects(
      sandbox.exec("node", ["--version"], { env: { FIXTURE: "sentinel" }, signal }),
      /cannot inject environment variables/,
    );
    const sealed = await sandbox.exec("node", ["-e", probe, repositoryUrl, address, fixturePath], {
      signal,
    });
    const sealedStatus = await sealed.exitCode;
    const { stdout, stderr } = await sealed.output();
    assert.equal(sealedStatus, 0, `Sealed replay probe failed: ${stderr}`);
    evidence = {
      denied: ["dns", "https", "git", "directIp"],
      digest: createHash("sha256").update(fixture).digest("hex"),
    };
    assert.deepEqual(JSON.parse(stdout), evidence);
  } finally {
    if (sandboxId) {
      await stopSandboxById(sandboxId, { connection, throwOnError: true });
      assert.equal(await hasRecoverableSandboxSource(sandboxId, connection), false);
    }
  }
  console.log(
    JSON.stringify({
      provider: "vercel",
      sandboxId,
      ...evidence,
      commandEnvironmentDenied: true,
      stoppedAndSourceRemoved: true,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Benchmark replay isolation smoke failed.",
  );
  process.exitCode = 1;
});
