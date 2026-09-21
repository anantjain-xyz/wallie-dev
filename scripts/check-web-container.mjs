import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const image = process.argv[2] ?? "wallie-web:local";
const prefix = `wallie-web-smoke-${randomUUID()}`;
const fixture = `${prefix}-supabase`;
const containers = [fixture];
const source = (name) => readFileSync(new URL(`./fixtures/${name}.mjs`, import.meta.url), "utf8");
function docker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  }
  return `${result.stdout ?? ""}${args[0] === "logs" ? (result.stderr ?? "") : ""}`.trim();
}
const exec = (container, code) =>
  docker(["exec", container, "node", "--input-type=module", "--eval", code]);
const state = (port) =>
  JSON.parse(
    exec(
      fixture,
      `console.log(await (await fetch("http://127.0.0.1:${port}/_smoke/state")).text())`,
    ),
  );
function cleanup() {
  docker(["rm", "--force", ...containers.reverse()], { allowFailure: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    cleanup();
    process.exit(1);
  });
}
async function waitFor(check, message) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {
      /* Containers may still be starting. */
    }
    await setTimeout(250);
  }
  throw new Error(message);
}

try {
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  const buildId = docker([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "node",
    imageId,
    "--eval",
    `const assert = require("node:assert/strict");
      const fs = require("node:fs");
      assert.notEqual(process.getuid(), 0, "Image must run as non-root");
      assert.equal(process.env.NODE_ENV, "production");
      assert.ok(fs.existsSync("LICENSE"));
      assert.ok(!fs.readdirSync(".").some(path => path.startsWith(".env")), "Environment files must not ship");
      for (const key of ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "WALLIE_ENCRYPTION_KEY"]) {
        assert.equal(process.env[key], undefined, key + " must be supplied at runtime");
      }
      for (const path of [".git", "src/worker/config.test.ts"]) {
        assert.equal(fs.existsSync(path), false, path + " must not ship");
      }
      console.log(fs.readFileSync(".next/BUILD_ID", "utf8"));`,
  ]);
  docker([
    "run",
    "--detach",
    "--name",
    fixture,
    "--network",
    "none",
    "--entrypoint",
    "node",
    imageId,
    "--input-type=module",
    "--eval",
    source("web-container-supabase"),
  ]);
  await waitFor(() => state(3001) && state(3002), "Supabase fixture did not start");
  for (const [installation, port] of [
    ["a", 3001],
    ["b", 3002],
  ]) {
    const web = `${prefix}-${installation}`;
    containers.push(web);
    const env = {
      WALLIE_DEPLOY_ENV: "production",
      NEXT_PUBLIC_APP_URL: `https://install-${installation}.wallie.invalid`,
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `web-container-public-${installation}`,
      SUPABASE_SECRET_KEY: "web-container-private-canary",
      WALLIE_ENCRYPTION_KEY: "ab".repeat(32),
      GITHUB_APP_PRIVATE_KEY: "web-container-github-private-canary",
    };
    docker([
      "run",
      "--detach",
      "--name",
      web,
      "--network",
      `container:${fixture}`,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      imageId,
    ]);
    await waitFor(
      () =>
        exec(
          fixture,
          'console.log((await fetch("http://127.0.0.1:3000/favicon.ico", {signal: AbortSignal.timeout(1000)})).status)',
        ) === "200",
      `Installation ${installation} did not start`,
    );
    assert.equal(docker(["inspect", "--format", "{{.Image}}", web]), imageId);
    assert.equal(
      exec(web, 'import fs from "node:fs"; console.log(fs.readFileSync(".next/BUILD_ID", "utf8"))'),
      buildId,
    );
    console.log(
      docker([
        "exec",
        "--env",
        `SMOKE_INSTALLATION=${installation}`,
        fixture,
        "node",
        "--input-type=module",
        "--eval",
        source("web-container-probe"),
      ]),
    );

    // Hold an uncached image until SIGTERM closes the listener with the request still active.
    const slowUrl = `http://127.0.0.1:${port}/storage/v1/object/public/workspace-avatars/smoke/slow.png`;
    const resultPath = `/tmp/drain-${installation}.json`;
    docker([
      "exec",
      "--detach",
      fixture,
      "node",
      "--input-type=module",
      "--eval",
      `import fs from "node:fs";
       try {
         const response = await fetch(${JSON.stringify(`http://127.0.0.1:3000/_next/image?url=${encodeURIComponent(slowUrl)}&w=64&q=75`)}, {signal: AbortSignal.timeout(45000)});
         const bytes = await response.arrayBuffer();
         fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({status: response.status, bytes: bytes.byteLength}));
       } catch (error) { fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({error: error.message})); }`,
    ]);
    await waitFor(() => state(port).slowStarted, "Slow image request did not reach fixture");
    docker(["kill", "--signal", "SIGTERM", web]);
    await waitFor(
      () =>
        exec(
          fixture,
          `try {
        await fetch("http://127.0.0.1:3000/favicon.ico", {signal: AbortSignal.timeout(1000)});
        console.log(false);
      } catch (error) { console.log(error.cause?.code === "ECONNREFUSED"); }`,
        ) === "true",
      "SIGTERM did not close the HTTP listener",
    );
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", web]),
      "true",
      "Server must remain alive to drain the active request",
    );
    assert.equal(state(port).slowCompleted, false, "Active request completed before release");
    assert.equal(
      exec(
        fixture,
        `console.log((await fetch("http://127.0.0.1:${port}/_smoke/release", {method: "POST"})).status)`,
      ),
      "200",
    );
    assert.equal(docker(["wait", web]), "143");
    const stopped = JSON.parse(docker(["inspect", "--format", "{{json .State}}", web]));
    assert.equal(stopped.ExitCode, 143, "Next.js must exit through its SIGTERM handler");
    assert.equal(stopped.OOMKilled, false);
    await waitFor(
      () =>
        exec(
          fixture,
          `import fs from "node:fs"; console.log(fs.existsSync(${JSON.stringify(resultPath)}))`,
        ) === "true",
      "Active image client did not record its result",
    );
    const drain = JSON.parse(
      exec(
        fixture,
        `import fs from "node:fs"; console.log(fs.readFileSync(${JSON.stringify(resultPath)}, "utf8"))`,
      ),
    );
    assert.equal(drain.status, 200, JSON.stringify(drain));
    assert.ok(drain.bytes > 0);
    assert.equal(state(port).slowCompleted, true);
    assert.deepEqual(state(port).errors, []);
  }
  console.log(
    `Web container passed: same image/build (${buildId}), two runtime installations, non-root, SIGTERM drains an active image request.`,
  );
} catch (error) {
  for (const container of containers)
    console.error(docker(["logs", container], { allowFailure: true }));
  console.error(error);
  process.exitCode = 1;
} finally {
  cleanup();
}
