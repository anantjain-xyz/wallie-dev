import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
};
type Runner = (command: string, args: string[], options?: CommandOptions) => Promise<string>;
let runCommand: Runner;
let archiveReviewedSource: (options: {
  run: Runner;
  env: NodeJS.ProcessEnv;
  cwd: string;
  revision: string;
  source: string;
  temporary: string;
  signal?: AbortSignal;
}) => Promise<{ root: string; origin: string; mainRevision: string }>;
beforeAll(async () => {
  const helper = new URL("../../../scripts/lib/aws-image-source.mjs", import.meta.url).href;
  const publisher = new URL("../../../scripts/publish-aws-image.mjs", import.meta.url).href;
  ({ archiveReviewedSource } = await import(helper));
  ({ runCommand } = await import(publisher));
});
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const origin = "https://github.com/anantjain-xyz/wallie-dev.git";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "wallie-source-test-"));
  directories.push(directory);
  const upstream = join(directory, "upstream");
  const checkout = join(directory, "checkout");
  const temporary = join(directory, "publish");
  const source = join(temporary, "source");
  const home = join(directory, "home");
  for (const path of [upstream, temporary, home]) mkdirSync(path);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    NODE_ENV: process.env.NODE_ENV,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: string[], cwd = checkout, input?: string) =>
    execFileSync("git", args, {
      cwd,
      env,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const user = [
    "-c",
    "user.name=Source test",
    "-c",
    "user.email=source@example.test",
    "-c",
    "commit.gpgsign=false",
  ];
  git(["init", "--initial-branch=main"], upstream);
  writeFileSync(join(upstream, "required.txt"), "first reviewed content\n");
  git(["add", "."], upstream);
  git([...user, "commit", "-m", "First reviewed commit"], upstream);
  const first = git(["rev-parse", "HEAD"], upstream);
  writeFileSync(join(upstream, "required.txt"), "reviewed source\n");
  writeFileSync(join(upstream, "Dockerfile"), "FROM scratch\n");
  git(["add", "."], upstream);
  git([...user, "commit", "-m", "Reviewed image source"], upstream);
  const revision = git(["rev-parse", "HEAD"], upstream);
  git(["clone", "--no-hardlinks", upstream, checkout], directory);
  git(["remote", "set-url", "origin", origin]);
  const calls: { command: string; args: string[]; options: CommandOptions }[] = [];
  const run: Runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    // Exercise every real Git command offline; only substitute the approved network endpoint.
    const actual =
      command === "git" && args.includes("fetch")
        ? args.map((arg) => (arg === origin ? upstream : arg))
        : args;
    return runCommand(command, actual, options);
  };
  const archive = (
    extra: { revision?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
  ) => archiveReviewedSource({ run, env, cwd: checkout, revision, source, temporary, ...extra });
  const commitTree = (parent?: string) =>
    git(
      [...user, "commit-tree", git(["write-tree"]), ...(parent ? ["-p", parent] : [])],
      checkout,
      "Unreviewed replacement\n",
    );
  return {
    directory,
    upstream,
    checkout,
    temporary,
    source,
    home,
    env,
    git,
    user,
    first,
    revision,
    calls,
    archive,
    commitTree,
  };
}

describe("isolated reviewed image source", () => {
  it("fetches approved main independently and archives an older reviewed commit", async () => {
    const f = fixture();
    writeFileSync(join(f.checkout, "required.txt"), "dirty checkout\n");
    writeFileSync(join(f.checkout, "untracked.txt"), "not reviewed\n");
    const result = await f.archive({ revision: f.first });
    expect(result).toEqual({ root: realpathSync(f.checkout), origin, mainRevision: f.revision });
    expect(readFileSync(join(f.source, "required.txt"), "utf8")).toBe("first reviewed content\n");
    expect(existsSync(join(f.source, "Dockerfile"))).toBe(false);
    expect(existsSync(join(f.source, "untracked.txt"))).toBe(false);
    expect(existsSync(join(f.temporary, "reviewed.git", "objects", "info", "alternates"))).toBe(
      false,
    );
    const fetch = f.calls.find((call) => call.args.includes("fetch"))!;
    expect(fetch.args.slice(-2)).toEqual([origin, "refs/heads/main:refs/remotes/origin/main"]);
    expect(fetch.args).toContain("--no-recurse-submodules");
  });

  it("ignores local replacement objects that change an otherwise accepted revision's tree", async () => {
    const f = fixture();
    writeFileSync(join(f.checkout, "required.txt"), "replacement source\n");
    f.git(["add", "."]);
    const replacement = f.commitTree(f.first);
    f.git(["replace", f.revision, replacement]);
    f.git(["merge-base", "--is-ancestor", f.revision, "refs/remotes/origin/main"]);
    expect(f.git(["show", `${f.revision}:required.txt`])).toBe("replacement source");

    await f.archive();
    expect(readFileSync(join(f.source, "required.txt"), "utf8")).toBe("reviewed source\n");
    for (const call of f.calls.filter((call) => call.command === "git")) {
      expect(call.args).toContain("--no-replace-objects");
      expect(call.options.env?.GIT_NO_REPLACE_OBJECTS).toBe("1");
    }
  });

  it("rejects unreviewed ancestry forged by a local replacement", async () => {
    const f = fixture();
    const unreviewed = f.commitTree();
    const replacement = f.commitTree(unreviewed);
    f.git(["replace", f.revision, replacement]);
    f.git(["merge-base", "--is-ancestor", unreviewed, "refs/remotes/origin/main"]);

    await expect(f.archive({ revision: unreviewed })).rejects.toThrow();
    expect(existsSync(f.source)).toBe(false);
    expect(f.calls.some((call) => call.args.includes("archive"))).toBe(false);
  });

  it("ignores checkout info attributes and global export attributes, templates, and URL rewrites", async () => {
    const f = fixture();
    const attributes = join(f.directory, "attributes");
    const template = join(f.directory, "template");
    mkdirSync(join(template, "info"), { recursive: true });
    writeFileSync(attributes, "Dockerfile export-ignore\n");
    writeFileSync(join(template, "info", "attributes"), "* export-ignore\n");
    writeFileSync(join(f.checkout, ".git", "info", "attributes"), "required.txt export-ignore\n");
    f.git(["config", "--global", "core.attributesFile", attributes]);
    f.git(["config", "--global", "init.templateDir", template]);
    f.git(["config", "--global", `url.${join(f.directory, "wrong-repository")}.insteadOf`, origin]);

    await f.archive();
    expect(readFileSync(join(f.source, "required.txt"), "utf8")).toBe("reviewed source\n");
    expect(readFileSync(join(f.source, "Dockerfile"), "utf8")).toBe("FROM scratch\n");
    expect(existsSync(join(f.temporary, "reviewed.git", "info", "attributes"))).toBe(false);
  });

  it("removes ambient Git metadata/config injection and tar options", async () => {
    const f = fixture();
    const env = {
      ...f.env,
      GIT_DIR: join(f.directory, "untrusted.git"),
      GIT_WORK_TREE: join(f.directory, "untrusted-tree"),
      GIT_COMMON_DIR: join(f.directory, "untrusted.git"),
      GIT_OBJECT_DIRECTORY: join(f.directory, "untrusted-objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(f.checkout, ".git", "objects"),
      GIT_CONFIG_GLOBAL: join(f.directory, "untrusted-config"),
      GIT_CONFIG_PARAMETERS: "'core.bare=true'",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
      GIT_ATTR_SOURCE: "HEAD~1",
      GIT_TEMPLATE_DIR: join(f.directory, "untrusted-template"),
      GIT_REPLACE_REF_BASE: "refs/replace-untrusted/",
      GIT_EXEC_PATH: join(f.directory, "untrusted-executables"),
      GIT_TRACE: join(f.directory, "untrusted-trace"),
      TAR_OPTIONS: "--this-option-must-not-be-used",
    };
    await f.archive({ env });
    expect(readFileSync(join(f.source, "required.txt"), "utf8")).toBe("reviewed source\n");
    for (const call of f.calls) {
      expect(call.options.env?.GIT_DIR).toBeUndefined();
      expect(call.options.env?.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(call.options.env?.GIT_TRACE).toBeUndefined();
      expect(call.options.env?.TAR_OPTIONS).toBeUndefined();
    }
  });

  it("preserves only normal system/global credential settings for fetching", async () => {
    const f = fixture();
    f.git(["config", "--global", "credential.helper", ""]);
    f.git(["config", "--global", "--add", "credential.helper", "!printf 'username=test\\n'"]);
    f.git(["config", "--global", "credential.https://github.com.username", "source-test"]);
    f.git(["config", "--global", "credential.https://github.com.useHttpPath", "true"]);
    f.git(["config", "credential.helper", "checkout-local-helper-must-not-transfer"]);
    f.git(["config", "--global", "http.sslVerify", "false"]);
    await f.archive();
    const fetch = f.calls.find((call) => call.args.includes("fetch"))!;
    const fetchEnv = fetch.options.env!;
    const config = Array.from({ length: Number(fetchEnv.GIT_CONFIG_COUNT) }, (_, index) => [
      fetchEnv[`GIT_CONFIG_KEY_${index}`],
      fetchEnv[`GIT_CONFIG_VALUE_${index}`],
    ]);
    expect(config).toContainEqual(["credential.helper", ""]);
    expect(config).toContainEqual(["credential.helper", "!printf 'username=test\\n'"]);
    expect(config).toContainEqual(["credential.https://github.com.username", "source-test"]);
    expect(config).toContainEqual(["credential.https://github.com.usehttppath", "true"]);
    expect(config.every(([key]) => /^credential\./.test(key!))).toBe(true);
    expect(config.flat()).not.toContain("checkout-local-helper-must-not-transfer");
    expect(fetchEnv.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(fetchEnv.GIT_CONFIG_NOSYSTEM).toBe("1");
    const archive = f.calls.find((call) => call.args.includes("archive"))!;
    expect(archive.options.env?.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("rejects origins that only rewrite to the approved URL", async () => {
    const f = fixture();
    f.git(["remote", "set-url", "origin", "untrusted:repository"]);
    f.git(["config", `url.${origin}.insteadOf`, "untrusted:repository"]);
    expect(f.git(["remote", "get-url", "origin"])).toBe(origin);
    await expect(f.archive()).rejects.toThrow("Origin must be the Wallie repository");
    expect(f.calls.some((call) => call.args.includes("fetch"))).toBe(false);
  });

  it("honors archive attributes committed in the reviewed tree", async () => {
    const f = fixture();
    writeFileSync(join(f.upstream, ".gitattributes"), "Dockerfile export-ignore\n");
    f.git(["add", "."], f.upstream);
    f.git([...f.user, "commit", "-m", "Reviewed archive attributes"], f.upstream);
    await f.archive({ revision: f.git(["rev-parse", "HEAD"], f.upstream) });
    expect(readFileSync(join(f.source, "required.txt"), "utf8")).toBe("reviewed source\n");
    expect(existsSync(join(f.source, "Dockerfile"))).toBe(false);
  });

  it("rejects non-commit object IDs and interrupted preparation before extraction", async () => {
    const f = fixture();
    const blob = f.git(["rev-parse", `${f.revision}:required.txt`]);
    await expect(f.archive({ revision: blob })).rejects.toThrow(
      "Revision must identify a reviewed commit",
    );
    expect(existsSync(f.source)).toBe(false);
    const other = fixture();
    await expect(other.archive({ signal: AbortSignal.abort() })).rejects.toThrow(
      "Publishing interrupted",
    );
    expect(existsSync(other.source)).toBe(false);
  });
});
