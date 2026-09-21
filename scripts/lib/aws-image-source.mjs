import { mkdirSync } from "node:fs";
import { join } from "node:path";

const origins = [
  "https://github.com/anantjain-xyz/wallie-dev.git",
  "https://github.com/anantjain-xyz/wallie-dev",
  "git@github.com:anantjain-xyz/wallie-dev.git",
];
const gitOptions = [
  "--no-replace-objects",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "fetch.fsckObjects=true",
];

/** Fetch reviewed history without inheriting the checkout's objects or archive attributes. */
export async function archiveReviewedSource({
  run,
  env = process.env,
  cwd,
  revision,
  source,
  temporary,
  signal,
}) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? ""))
    throw new Error("Revision must be a full Git commit SHA");

  // Remove object directories, replacement refs, config injection, templates, and traces.
  // HOME and SSH_AUTH_SOCK remain available to the user's authentication helpers.
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith("GIT_") && key !== "TAR_OPTIONS"),
  );
  const gitEnv = {
    ...cleanEnv,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const local = (args) => run("git", [...gitOptions, ...args], { cwd, env: gitEnv, signal });
  // Read the literal repository URL; `remote get-url` applies url.*.insteadOf rewrites.
  const origin = await local([
    "config",
    "--local",
    "--no-includes",
    "--get-all",
    "remote.origin.url",
  ]);
  if (!origins.includes(origin)) throw new Error("Origin must be the Wallie repository");
  const root = await local(["rev-parse", "--show-toplevel"]);

  const metadata = join(temporary, "reviewed.git");
  const template = join(temporary, "empty-git-template");
  mkdirSync(metadata, { mode: 0o700 });
  mkdirSync(template, { mode: 0o700 });
  const isolated = (args, extra = {}) =>
    run("git", [...gitOptions, `--git-dir=${metadata}`, ...args], {
      cwd: temporary,
      env: gitEnv,
      signal,
      ...extra,
    });
  await isolated([
    "init",
    "--bare",
    "--object-format=sha1",
    "--initial-branch=main",
    `--template=${template}`,
  ]);

  // Preserve only authentication settings from normal system/global config. Reading them
  // inside the new bare repository excludes checkout-local credential/config overrides.
  const config = await isolated(["config", "--null", "--list", "--includes"], {
    env: { ...cleanEnv, GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  const fetchEnv = { ...gitEnv };
  let count = 0;
  for (const record of config.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\n");
    const key = separator < 0 ? record : record.slice(0, separator);
    if (!/^credential(?:\..+)?\.(helper|username|usehttppath)$/i.test(key)) continue;
    fetchEnv[`GIT_CONFIG_KEY_${count}`] = key;
    fetchEnv[`GIT_CONFIG_VALUE_${count++}`] = separator < 0 ? "true" : record.slice(separator + 1);
  }
  fetchEnv.GIT_CONFIG_COUNT = String(count);
  await isolated(
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      origin,
      "refs/heads/main:refs/remotes/origin/main",
    ],
    { env: fetchEnv, timeout: 600_000 },
  );
  if ((await isolated(["cat-file", "-t", revision])) !== "commit")
    throw new Error("Revision must identify a reviewed commit");
  await isolated(["merge-base", "--is-ancestor", revision, "refs/remotes/origin/main"]);
  const mainRevision = await isolated(["rev-parse", "refs/remotes/origin/main"]);
  const archive = join(temporary, "source.tar");
  await isolated(["archive", "--format=tar", `--output=${archive}`, revision]);
  mkdirSync(source, { mode: 0o700 });
  await run("tar", ["-xf", archive, "-C", source], { cwd: temporary, env: gitEnv, signal });
  return { root, origin, mainRevision };
}
