import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// Raw AWS fixtures intentionally exercise malformed and missing response fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
let prepare: (mode: string, input: Data, evidence: Data, now?: number) => Data;
const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-runtime-secret-canary.mjs", import.meta.url),
);
beforeAll(async () => {
  ({ prepareCanary: prepare } = await import(new URL(`file://${script}`).href));
});
const account = "123456789012",
  region = "us-west-2",
  runId = "1".repeat(32);
const now = Date.parse("2026-09-22T12:05:00Z");
function inputs(component = "web") {
  return {
    schemaVersion: 1,
    account,
    region,
    component,
    runId,
    secretArn: `arn:aws:secretsmanager:${region}:${account}:secret:/wallie/staging/${component}/runtime-AbC123`,
  };
}
function fixture(state = "empty", component = "web", captured = now - 1_000) {
  const input = inputs(component);
  const identity = { ARN: input.secretArn, Name: `/wallie/staging/${component}/runtime` };
  const labels = state === "active" ? ["AWSCURRENT"] : [];
  const wrap = (response: Data) => ({
    requestStartedAt: new Date(captured - 100).toISOString(),
    capturedAt: new Date(captured).toISOString(),
    response,
  });
  const evidence: Data = {
    secret: wrap({
      ...identity,
      Description: `Wallie staging ${component} runtime secret configuration; values managed outside Terraform.`,
      Tags: Object.entries({
        Project: "Wallie",
        Environment: "staging",
        ManagedBy: "Terraform",
        WallieStack: "wallie-staging-application",
        Component: "runtime-secrets",
        Name: identity.Name,
      }).map(([Key, Value]) => ({ Key, Value })),
      VersionIdsToStages: state === "empty" ? {} : { [runId]: labels },
    }),
    resourcePolicy: wrap({ ...identity }),
    versions: {
      ...wrap({
        ...identity,
        Versions: state === "empty" ? [] : [{ VersionId: runId, VersionStages: labels }],
      }),
      request: { SecretId: input.secretArn, IncludeDeprecated: true },
    },
    operation: {
      requestStartedAt: new Date(captured - 400).toISOString(),
      capturedAt: new Date(captured - 200).toISOString(),
      response: {
        ...identity,
        ...(state === "active" ? { VersionId: runId, VersionStages: labels } : {}),
      },
    },
  };
  return { input, evidence };
}
const invoke = (mode: string, f = fixture(), time = now) =>
  prepare(mode, f.input, f.evidence, time);

describe("offline runtime secret canary", () => {
  it.each(["web", "worker"])("renders only the derived public canary for %s", (component) => {
    const f = fixture("empty", component),
      original = structuredClone(f);
    const result = invoke("put-input", f);
    expect(result).toEqual({
      SecretId: f.input.secretArn,
      ClientRequestToken: runId,
      SecretString: JSON.stringify({ WALLIE_SMOKE_CANARY: `wallie-smoke:${component}:${runId}` }),
      VersionStages: ["AWSCURRENT"],
    });
    expect(f).toEqual(original);
    expect(JSON.stringify(result)).not.toMatch(
      /SUPABASE_SECRET_KEY|WALLIE_ENCRYPTION_KEY|AWS_SECRET_ACCESS_KEY/,
    );
  });

  it("verifies written version metadata without claiming content or deployment proof", () => {
    const result = invoke("verify", fixture("active"));
    expect(result.status).toBe("canary-version-metadata-matched");
    expect(result.deployable).toBe(false);
    expect(result.limitation).toContain("cannot authenticate captures or prove value contents");
  });

  it.each(["SecretString", "SecretBinary"])(
    "rejects %s in every metadata and operation response",
    (field) => {
      for (const name of ["secret", "versions", "resourcePolicy", "operation"]) {
        const f = fixture("active");
        f.evidence[name].response[field] = "must-not-appear";
        expect(() => invoke("verify", f)).toThrow("Value-bearing responses are not metadata");
      }
    },
  );

  it("removes only AWSCURRENT from this exact canary version", () => {
    const f = fixture("active");
    expect(invoke("cleanup-input", f)).toEqual({
      SecretId: f.input.secretArn,
      VersionStage: "AWSCURRENT",
      RemoveFromVersionId: runId,
    });
  });

  it.each([{ keys: [] }, { keys: ["key-id"] }, { keys: ["alias/aws/secretsmanager"] }])(
    "accepts documented informational KmsKeyIds string arrays %j",
    ({ keys }) => {
      const f = fixture("active");
      f.evidence.versions.response.Versions[0].KmsKeyIds = keys;
      expect(() => invoke("verify", f)).not.toThrow();
    },
  );

  it.each([{ value: null }, { value: "key-id" }, { value: [42] }])(
    "rejects malformed KmsKeyIds %j",
    ({ value }) => {
      const f = fixture("active");
      f.evidence.versions.response.Versions[0].KmsKeyIds = value;
      expect(() => invoke("verify", f)).toThrow();
    },
  );

  it.each([false, true])(
    "verifies a deprecated canary remains with no labels (omitted map: %s)",
    (omitMap) => {
      const f = fixture("retired");
      if (omitMap) delete f.evidence.secret.response.VersionIdsToStages;
      const result = invoke("verify-cleanup", f);
      expect(result.status).toBe("canary-label-removed");
      expect(result.limitation).toContain("does not restore an empty secret");
      expect(() => invoke("put-input", f)).toThrow(/initial version inventory/);
    },
  );

  it.each([
    [
      "secretArn",
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:/wallie/staging/web/runtime-AbC123",
    ],
    [
      "secretArn",
      "arn:aws:secretsmanager:us-west-2:999999999999:secret:/wallie/staging/web/runtime-AbC123",
    ],
    [
      "secretArn",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-AbC123",
    ],
    [
      "secretArn",
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-??????",
    ],
    ["secretArn", `${inputs().secretArn}:WALLIE_SMOKE_CANARY::${runId}`],
    ["runId", "short"],
    ["runId", "F".repeat(32)],
    ["component", "database"],
    ["region", "cn-north-1"],
    ["region", "us-gov-west-1"],
    ["account", "123"],
    ["schemaVersion", 2],
    ["secretValue", "must-not-be-accepted"],
  ])("rejects unexpected %s inputs", (key, value) => {
    const f = fixture();
    (f.input as Data)[key] = value;
    expect(() => invoke("put-input", f)).toThrow();
  });

  it.each([
    [
      "wrong metadata ARN",
      (e: Data) => {
        e.secret.response.ARN = inputs("worker").secretArn;
      },
    ],
    [
      "wrong inventory identity",
      (e: Data) => {
        e.versions.response.Name = "other";
      },
    ],
    [
      "wrong policy identity",
      (e: Data) => {
        e.resourcePolicy.response.ARN = inputs("worker").secretArn;
      },
    ],
    [
      "ownership tag changed",
      (e: Data) => {
        e.secret.response.Tags[0].Value = "Other";
      },
    ],
    [
      "duplicate tag",
      (e: Data) => {
        e.secret.response.Tags.push(e.secret.response.Tags[0]);
      },
    ],
    [
      "deletion scheduled",
      (e: Data) => {
        e.secret.response.DeletedDate = "2026-09-30T00:00:00Z";
      },
    ],
    [
      "custom encryption",
      (e: Data) => {
        e.secret.response.KmsKeyId = "other-key";
      },
    ],
    [
      "rotation enabled",
      (e: Data) => {
        e.secret.response.RotationEnabled = true;
      },
    ],
    [
      "rotation rules",
      (e: Data) => {
        e.secret.response.RotationRules = { AutomaticallyAfterDays: 1 };
      },
    ],
    [
      "replicas",
      (e: Data) => {
        e.secret.response.ReplicationStatus = [{ Region: "us-east-1" }];
      },
    ],
    [
      "resource policy",
      (e: Data) => {
        e.resourcePolicy.response.ResourcePolicy = "{}";
      },
    ],
    [
      "version pagination",
      (e: Data) => {
        e.versions.response.NextToken = "more";
      },
    ],
    [
      "omitted deprecated inclusion",
      (e: Data) => {
        delete e.versions.request;
      },
    ],
    [
      "false deprecated inclusion",
      (e: Data) => {
        e.versions.request.IncludeDeprecated = false;
      },
    ],
    [
      "different inventory request",
      (e: Data) => {
        e.versions.request.SecretId = inputs("worker").secretArn;
      },
    ],
    [
      "hidden deprecated version",
      (e: Data) => {
        e.versions.response.Versions = [{ VersionId: "2".repeat(32) }];
      },
    ],
    [
      "inconsistent described labels",
      (e: Data) => {
        e.secret.response.VersionIdsToStages = { [runId]: ["AWSCURRENT"] };
      },
    ],
    [
      "missing explicit inventory",
      (e: Data) => {
        delete e.versions.response.Versions;
      },
    ],
    [
      "malformed empty map",
      (e: Data) => {
        e.secret.response.VersionIdsToStages = null;
      },
    ],
  ] as const)("blocks first canary write on %s", (_name, mutate) => {
    const f = fixture();
    mutate(f.evidence);
    expect(() => invoke("put-input", f)).toThrow();
  });

  it.each(["verify", "cleanup-input"])(
    "%s rejects replacement, extra versions, and changed labels",
    (mode) => {
      for (const mutate of [
        (e: Data) => {
          e.versions.response.Versions[0].VersionId = "2".repeat(32);
        },
        (e: Data) => {
          e.versions.response.Versions.push({ VersionId: "2".repeat(32), VersionStages: [] });
        },
        (e: Data) => {
          e.versions.response.Versions[0].VersionStages.push("OTHER");
        },
        (e: Data) => {
          e.secret.response.VersionIdsToStages = { [runId]: ["AWSCURRENT", "OTHER"] };
        },
        (e: Data) => {
          e.versions.response.Versions[0].VersionStages = [];
        },
      ]) {
        const f = fixture("active");
        mutate(f.evidence);
        expect(() => invoke(mode, f)).toThrow();
      }
    },
  );

  it("requires correct operation metadata and subsequent captures", () => {
    for (const mutate of [
      (e: Data) => {
        e.operation.response.VersionId = "2".repeat(32);
      },
      (e: Data) => {
        e.operation.response.VersionStages = ["OTHER"];
      },
      (e: Data) => {
        e.operation.response.ARN = inputs("worker").secretArn;
      },
      (e: Data) => {
        e.operation.capturedAt = new Date(now - 1_000).toISOString();
      },
    ]) {
      const f = fixture("active");
      mutate(f.evidence);
      expect(() => invoke("verify", f)).toThrow();
    }
  });

  it("requires a retained unlabeled version after cleanup, with no foreign labels", () => {
    for (const mutate of [
      (e: Data) => {
        e.versions.response.Versions = [];
      },
      (e: Data) => {
        e.versions.response.Versions[0].VersionStages = ["AWSCURRENT"];
      },
      (e: Data) => {
        e.secret.response.VersionIdsToStages = { [runId]: ["OTHER"] };
      },
      (e: Data) => {
        e.versions.response.Versions[0].VersionStages = null;
      },
    ]) {
      const f = fixture("retired");
      mutate(f.evidence);
      expect(() => invoke("verify-cleanup", f)).toThrow();
    }
  });

  it.each(["secret", "versions", "resourcePolicy"])(
    "requires fresh request and response times for %s",
    (name) => {
      const f = fixture();
      f.evidence[name].requestStartedAt = new Date(now - 15 * 60_000).toISOString();
      expect(() => invoke("put-input", f)).not.toThrow();
      f.evidence[name].requestStartedAt = new Date(now - 15 * 60_000 - 1).toISOString();
      expect(() => invoke("put-input", f)).toThrow(/fresh/);
      f.evidence[name].requestStartedAt = new Date(now + 1).toISOString();
      expect(() => invoke("put-input", f)).toThrow();
      f.evidence[name].requestStartedAt = "invalid";
      expect(() => invoke("put-input", f)).toThrow();
    },
  );
});

describe("canary CLI boundaries", () => {
  function run(
    f: ReturnType<typeof fixture>,
    modify?: (directory: string) => void,
    extra: string[] = [],
  ) {
    const directory = mkdtempSync(join(tmpdir(), "wallie-canary-test-"));
    try {
      writeFileSync(join(directory, "inputs.json"), JSON.stringify(f.input));
      for (const [key, suffix] of [
        ["secret", "secret"],
        ["versions", "versions"],
        ["resourcePolicy", "resource-policy"],
      ])
        writeFileSync(join(directory, `web-${suffix}.json`), JSON.stringify(f.evidence[key]));
      modify?.(directory);
      return spawnSync(
        process.execPath,
        [
          script,
          "put-input",
          "--manifest",
          join(directory, "inputs.json"),
          "--readback-dir",
          directory,
          ...extra,
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            NODE_ENV: "test",
            PATH: "",
            AWS_ACCESS_KEY_ID: "must-not-appear",
            AWS_SECRET_ACCESS_KEY: "must-not-appear",
            AWS_SESSION_TOKEN: "must-not-appear",
          },
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  it("runs offline with an empty PATH and ignores ambient credentials", () => {
    const result = run(fixture("empty", "web", Date.now() - 1_000));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("must-not-appear");
  });
  it.each([
    ["--secret-value", "must-not-appear"],
    ["--manifest", "must-not-appear"],
    ["must-not-appear"],
  ])("rejects extra arguments without echoing supplied content %j", (...extra) => {
    const result = run(fixture("empty", "web", Date.now() - 1_000), undefined, extra);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("must-not-appear");
  });
  it.each(["malformed", "oversized", "symlink"])(
    "rejects %s metadata without echoing its contents",
    (kind) => {
      const result = run(fixture("empty", "web", Date.now() - 1_000), (dir) => {
        const target = join(dir, "web-secret.json");
        if (kind === "symlink") {
          rmSync(target);
          symlinkSync(join(dir, "inputs.json"), target);
        } else
          writeFileSync(
            target,
            kind === "malformed" ? "must-not-appear" : "must-not-appear".repeat(100_000),
          );
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("must-not-appear");
    },
  );

  it("rejects an accidentally value-bearing capture without echoing its content", () => {
    const f = fixture("empty", "web", Date.now() - 1_000);
    f.evidence.secret.response.SecretString = "must-not-appear";
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("must-not-appear");
  });
});
