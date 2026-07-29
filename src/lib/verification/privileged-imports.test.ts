import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { privilegedImportBoundaryConfig } from "../../../scripts/privileged-import-boundaries.config";
import {
  formatPrivilegedImportDiagnostics,
  type PrivilegedImportBoundaryConfig,
  verifyPrivilegedImports,
} from "../../../scripts/verify-privileged-imports";

const fixtureRoot = resolve(process.cwd(), "test/fixtures/privileged-imports");

function fixtureConfig(
  fixture: string,
  exceptions: PrivilegedImportBoundaryConfig["exceptions"] = [],
): PrivilegedImportBoundaryConfig {
  const root = `cases/${fixture}`;
  return {
    browserEntryPoints: [],
    exceptions,
    ownerRules: [
      {
        boundary: "worker-runtime",
        description: "fixture worker",
        id: "worker",
        pathPrefix: `${root}/worker/`,
      },
      {
        boundary: "next-route",
        description: "fixture privileged route",
        id: "privileged-route",
        pathPrefix: `${root}/app/`,
        pathSuffix: "/route.ts",
      },
      {
        boundary: "server-only-import",
        description: "fixture server service",
        id: "server-service",
      },
    ],
    privilegedModules: [
      {
        approvedOwnerIds: ["worker", "privileged-route", "server-service"],
        description: "fixture service-role client",
        path: `${root}/admin.ts`,
        requiresServerOnlyImport: true,
      },
    ],
    sourceRoots: [root],
  };
}

function verifyFixture(
  fixture: string,
  exceptions: PrivilegedImportBoundaryConfig["exceptions"] = [],
) {
  return verifyPrivilegedImports({
    config: fixtureConfig(fixture, exceptions),
    projectRoot: fixtureRoot,
    tsconfigPath: "tsconfig.json",
  });
}

describe("privileged import boundary verifier", () => {
  it("keeps the Wallie production graph within the declared boundaries", () => {
    expect(
      verifyPrivilegedImports({
        config: privilegedImportBoundaryConfig,
        projectRoot: process.cwd(),
      }),
    ).toEqual([]);
  }, 15_000);

  it("reports an indirect aliased browser path and its forbidden edge", () => {
    const diagnostics = verifyFixture("indirect-alias");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "client-reachability",
      from: "cases/indirect-alias/bridge.ts",
      to: "cases/indirect-alias/admin.ts",
    });
    expect(formatPrivilegedImportDiagnostics(diagnostics)).toContain(
      "cases/indirect-alias/client.ts -> cases/indirect-alias/bridge.ts -> cases/indirect-alias/admin.ts",
    );
    expect(diagnostics[0]?.message).toContain("fixture server service");
  });

  it("allows erased type-only imports", () => {
    expect(verifyFixture("type-only")).toEqual([]);
  });

  it("rejects a mixed type-and-value import from a client module", () => {
    const diagnostics = verifyFixture("mixed-type-value");

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "unapproved-owner",
      "client-reachability",
    ]);
  });

  it("rejects direct service-role imports without an approved owner boundary", () => {
    const diagnostics = verifyFixture("invalid-owner");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      approvedOwners: ["fixture worker", "fixture privileged route", "fixture server service"],
      code: "unapproved-owner",
      from: "cases/invalid-owner/shared.ts",
      line: 1,
      to: "cases/invalid-owner/admin.ts",
    });
  });

  it("rejects a privileged module without a direct server-only boundary", () => {
    const diagnostics = verifyFixture("missing-boundary");

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "missing-server-only-boundary",
      from: "cases/missing-boundary/admin.ts",
    });
  });

  it("accepts declared worker, route, and server-service seams", () => {
    expect(verifyFixture("valid-seams")).toEqual([]);
  });

  it("consumes a documented exception with an owner and reason", () => {
    expect(
      verifyFixture("invalid-owner", [
        {
          code: "unapproved-owner",
          from: "cases/invalid-owner/shared.ts",
          owner: "security@example.com",
          reason: "Temporary migration seam with a tracked removal date.",
          to: "cases/invalid-owner/admin.ts",
        },
      ]),
    ).toEqual([]);
  });

  it("fails when an exception no longer suppresses a violation", () => {
    const diagnostics = verifyFixture("valid-seams", [
      {
        code: "unapproved-owner",
        from: "cases/valid-seams/removed.ts",
        owner: "security@example.com",
        reason: "The old import was removed.",
        to: "cases/valid-seams/admin.ts",
      },
    ]);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "unused-exception",
      from: "cases/valid-seams/removed.ts",
      to: "cases/valid-seams/admin.ts",
    });
  });

  it("rejects exception metadata without an owner and reason", () => {
    const diagnostics = verifyFixture("invalid-owner", [
      {
        code: "unapproved-owner",
        from: "cases/invalid-owner/shared.ts",
        owner: "",
        reason: "",
        to: "cases/invalid-owner/admin.ts",
      },
    ]);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("invalid-config");
  });
});
