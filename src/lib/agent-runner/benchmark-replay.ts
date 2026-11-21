import type { SandboxHandle } from "@/lib/sandbox/types";

// This value only satisfies the CLI's local API authentication setup. The
// inference relay authenticates the sandbox and supplies the upstream key.
export const BENCHMARK_REPLAY_API_PLACEHOLDER = "wallie-benchmark-sandbox-placeholder";

// The CLI expects the prompt on stdin. Connect a private file directly and
// preserve only the provider's trusted PATH and firewall CA settings.
const launchWithPrompt = `
const {openSync, closeSync} = require("node:fs");
const {spawn} = require("node:child_process");
const [promptFile, program, names, ...args] = process.argv.slice(1);
const keys = ["PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", ...JSON.parse(names)];
const env = Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
const fd = openSync(promptFile, "r");
const child = spawn(program, args, {env, stdio: [fd, "inherit", "inherit"]});
closeSync(fd);
child.on("error", () => process.exitCode = 1);
child.on("exit", (code) => process.exitCode = code ?? 1);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
`;

export function launchBenchmarkCli(input: {
  sandbox: SandboxHandle;
  executablePath: string;
  args: string[];
  environment: Record<string, string>;
  promptFile: string;
  signal?: AbortSignal;
}) {
  const { sandbox, executablePath, args, environment, promptFile, signal } = input;
  return sandbox.exec(
    "env",
    [
      ...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
      "node",
      "-e",
      launchWithPrompt,
      "--",
      promptFile,
      executablePath,
      JSON.stringify(Object.keys(environment)),
      ...args,
    ],
    { cwd: sandbox.repoPath, signal },
  );
}
