import type { AgentProvider, SandboxHandle } from "@/lib/sandbox/types";
import type {
  SandboxCapabilityName,
  SandboxCapabilityReport,
  SandboxCapabilityResult,
} from "@/lib/sandbox-capabilities/contracts";

type CommandResult = {
  code: number;
  stderr: string;
  stdout: string;
};

type ResultOptions = {
  allowEmptySuccess?: boolean;
  emptySuccessDetail?: string;
};

const PLAYWRIGHT_SMOKE_SCRIPT = String.raw`
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.setContent("<main style='font-family:sans-serif'><h1>Wallie screenshot smoke</h1></main>");
  await page.screenshot({ path: "/tmp/wallie-playwright-smoke.png", fullPage: true });
  await browser.close();
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;

function agentCliCommand(provider: AgentProvider): string {
  switch (provider) {
    case "codex":
      return "command -v codex && codex --version";
    case "claude-code":
      return "command -v claude && claude --version";
  }
}

async function run(sandbox: SandboxHandle, command: string): Promise<CommandResult> {
  const proc = await sandbox.exec("bash", ["-lc", command], { cwd: sandbox.repoPath });
  const [{ stdout, stderr }, code] = await Promise.all([proc.output(), proc.exitCode]);
  console.info("[sandbox-capability-probe]", {
    code,
    command: command.slice(0, 200),
    stderrLen: stderr.length,
    stdoutLen: stdout.length,
  });
  return { code, stderr, stdout };
}

function result(
  command: CommandResult,
  fallback: string,
  options: ResultOptions = {},
): SandboxCapabilityResult {
  const output = (command.stdout || command.stderr).trim().slice(0, 500);
  if (command.code === 0 && (output.length > 0 || options.allowEmptySuccess)) {
    return {
      detail:
        output || options.emptySuccessDetail || "Command completed successfully with no output.",
      ok: true,
    };
  }
  return { detail: output || fallback, ok: false };
}

async function record(
  report: Partial<SandboxCapabilityReport>,
  name: SandboxCapabilityName,
  command: Promise<CommandResult>,
  fallback: string,
  options?: ResultOptions,
) {
  report[name] = result(await command, fallback, options);
}

export async function probeSandboxCapabilities(input: {
  agentProvider: AgentProvider;
  bootstrapPlaywright?: boolean;
  sandbox: SandboxHandle;
}): Promise<SandboxCapabilityReport> {
  const report: Partial<SandboxCapabilityReport> = {};
  const sandbox = input.sandbox;

  await record(report, "git", run(sandbox, "git --version"), "git not found");
  await record(report, "node", run(sandbox, "node --version"), "node not found");
  await record(
    report,
    "packageManager",
    run(
      sandbox,
      'for pm in pnpm npm yarn; do if command -v "$pm" >/dev/null 2>&1; then "$pm" --version | sed "s/^/$pm /"; exit 0; fi; done; exit 1',
    ),
    "no package manager found",
  );
  await record(
    report,
    "agentCli",
    run(sandbox, agentCliCommand(input.agentProvider)),
    "agent CLI not found",
  );

  const playwrightCheck = await run(
    sandbox,
    "node -e \"require.resolve('playwright'); console.log(require('playwright/package.json').version)\"",
  );
  report.playwrightPackage = result(playwrightCheck, "playwright package not found");

  if (!report.playwrightPackage.ok && input.bootstrapPlaywright !== false) {
    const install = await run(
      sandbox,
      "npm install --no-save playwright@^1.56.0 >/tmp/wallie-playwright-install.log 2>&1 && node -e \"require.resolve('playwright'); console.log(require('playwright/package.json').version)\"",
    );
    report.playwrightPackage = result(install, "playwright bootstrap failed");
  }

  if (report.playwrightPackage.ok) {
    await record(
      report,
      "chromium",
      run(sandbox, "npx playwright install chromium"),
      "chromium install failed",
    );
    await record(
      report,
      "screenshotSmoke",
      run(sandbox, `node <<'NODE'\n${PLAYWRIGHT_SMOKE_SCRIPT}\nNODE`),
      "playwright screenshot smoke failed",
      {
        allowEmptySuccess: true,
        emptySuccessDetail: "Playwright screenshot smoke passed.",
      },
    );
  } else {
    report.chromium = { detail: "Skipped because Playwright package is unavailable.", ok: false };
    report.screenshotSmoke = {
      detail: "Skipped because Playwright package is unavailable.",
      ok: false,
    };
  }

  return report as SandboxCapabilityReport;
}

export function capabilityReportSucceeded(report: Partial<SandboxCapabilityReport>): boolean {
  return Object.values(report).every((entry) => entry?.ok === true);
}
