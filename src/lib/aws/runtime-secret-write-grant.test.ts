import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const renderer = fileURLToPath(
  new URL("../../../scripts/prepare-aws-runtime-secret-write-grant.mjs", import.meta.url),
);
const baseline = fileURLToPath(
  new URL("../../../scripts/prepare-aws-secrets.mjs", import.meta.url),
);
const account = "111614490109";
const region = "us-west-2";
const components = ["web", "worker"] as const;
type Statement = {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: { StringEquals?: Record<string, string> };
};

function run(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 5000,
    env: { NODE_ENV: "test", PATH: "" },
  });
}

describe("temporary AWS runtime secret write grant", () => {
  it("preserves the existing policy and adds only two exact, owned PutSecretValue resources", async () => {
    const original = run(baseline, ["--account-id", account, "--region", region]);
    const rendered = run(renderer);
    expect(original.status).toBe(0);
    expect(rendered.status).toBe(0);
    expect(rendered.stderr).toBe("");
    const base = JSON.parse(original.stdout) as { Version: string; Statement: Statement[] };
    const policy = JSON.parse(rendered.stdout) as { Version: string; Statement: Statement[] };
    expect(policy.Version).toBe(base.Version);
    expect(policy.Statement.slice(0, base.Statement.length)).toEqual(base.Statement);
    expect(policy.Statement).toHaveLength(base.Statement.length + 2);
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6144);
    expect(rendered.stdout).not.toMatch(/SecretString|SecretBinary|GetSecretValue/);

    const populationScript = new URL(
      "../../../scripts/populate-aws-runtime-secrets.mjs",
      import.meta.url,
    );
    const { validateConfig } = (await import(populationScript.href)) as {
      validateConfig: (input: { webVersionId: string; workerVersionId: string }) => {
        secrets: Record<(typeof components)[number], { arn: string }>;
      };
    };
    const population = validateConfig({
      webVersionId: "a".repeat(32),
      workerVersionId: "b".repeat(32),
    });
    for (const [index, component] of components.entries()) {
      const statement = policy.Statement[base.Statement.length + index];
      expect(statement).toEqual({
        Sid: `TemporaryPut${component[0].toUpperCase()}${component.slice(1)}RuntimeValue`,
        Effect: "Allow",
        Action: "secretsmanager:PutSecretValue",
        Resource: population.secrets[component].arn,
        Condition: {
          StringEquals: {
            "aws:PrincipalAccount": account,
            "aws:RequestedRegion": region,
            "aws:ResourceTag/WallieStack": "wallie-staging-application",
            "aws:ResourceTag/Component": "runtime-secrets",
            "aws:ResourceTag/Name": `/wallie/staging/${component}/runtime`,
          },
        },
      });
      expect(statement.Resource).not.toMatch(/[?*]/);
    }
  });

  it.each([["--account-id", account], ["grant"], ["--help"]])(
    "rejects unexpected arguments without emitting a policy: %j",
    (...args) => {
      const result = run(renderer, args);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("[aws-runtime-secret-write-grant]");
    },
  );
});
