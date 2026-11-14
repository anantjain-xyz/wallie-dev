import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import register from "../../../docs/plans/factory-capabilities.json";
import delivery from "../../../docs/plans/linear-delivery-map.json";
import { checkFactoryPlan } from "../../../scripts/check-factory-plan";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const plansPath = "docs/plans";
let directory: string;

function writeRegister(change: (fixture: typeof register) => void) {
  const fixture = structuredClone(register);
  change(fixture);
  writeFileSync(join(directory, plansPath, "factory-capabilities.json"), JSON.stringify(fixture));
}

function writeDelivery(change: (fixture: typeof delivery) => void) {
  const fixture = structuredClone(delivery);
  change(fixture);
  writeFileSync(join(directory, plansPath, "linear-delivery-map.json"), JSON.stringify(fixture));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "wallie-factory-plan-"));
  mkdirSync(join(directory, plansPath), { recursive: true });
  for (const name of [
    "factory-capabilities.json",
    "factory-implementation-plan.md",
    "factory-capability-matrix.md",
    "linear-delivery-map.json",
  ]) {
    copyFileSync(join(root, plansPath, name), join(directory, plansPath, name));
  }
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("factory plan coverage", () => {
  it("accepts the checked-in plan", () => {
    expect(checkFactoryPlan(directory)).toEqual([]);
  });

  it("identifies the missing capability even if a duplicate keeps the row count at 100", () => {
    writeRegister((fixture) => {
      fixture.capabilities[99] = fixture.capabilities[0];
    });
    expect(checkFactoryPlan(directory)).toEqual(
      expect.arrayContaining([
        "Capability register: duplicate F001",
        "Capability register: missing F100",
      ]),
    );
  });

  it("identifies dangling capability, milestone and reuse references", () => {
    writeRegister((fixture) => {
      fixture.capabilities[0].depends_on.push("F101");
      fixture.capabilities[0].reuse.push("R99");
      fixture.capabilities[0].delivery_milestone = "M99";
    });
    expect(checkFactoryPlan(directory)).toEqual(
      expect.arrayContaining([
        "Capability register: F001 depends on unknown F101",
        "F001: unknown milestone M99",
        "F001: unknown reuse reference R99",
        "Capability matrix: F001 is in M03, expected M99",
      ]),
    );
  });

  it("rejects dependency cycles in the capability and milestone registers", () => {
    writeRegister((fixture) => {
      fixture.capabilities[0].depends_on.push("F001");
      fixture.milestones[0].depends_on.push("M01");
    });
    expect(checkFactoryPlan(directory)).toEqual(
      expect.arrayContaining([
        "Capability register: dependency cycle F001 → F001",
        "Milestone register: dependency cycle M00 → M01 → M00",
      ]),
    );
  });

  it("rejects dangling references introduced in the markdown matrix alone", () => {
    const path = join(directory, plansPath, "factory-capability-matrix.md");
    const matrix = readFileSync(path, "utf8");
    writeFileSync(
      path,
      matrix.replace(/^(\|\s*\*\*F001[^\n]*?Reuse: )R01([^\n]*?Requires: )F008/mu, "$1R99$2F101"),
    );
    expect(checkFactoryPlan(directory)).toEqual(
      expect.arrayContaining([
        "Capability matrix F001 reuse: unexpected R99",
        "Capability matrix F001 prerequisites: unexpected F101",
      ]),
    );
  });

  it("rejects a cycle and a missing blocker in the checked-in Linear map", () => {
    writeDelivery((fixture) => {
      fixture.issues[0].blocked_by.push("FCT-M00-02", "FCT-M00-99");
      fixture.counts.blocking_relationships += 2;
    });
    expect(checkFactoryPlan(directory)).toEqual(
      expect.arrayContaining([
        "Linear issue map: dependency cycle FCT-M00-01 → FCT-M00-02 → FCT-M00-01",
        "Linear issue map: FCT-M00-01 depends on unknown FCT-M00-99",
      ]),
    );
  });

  it("reports malformed JSON before reading its fields", () => {
    writeFileSync(join(directory, plansPath, "factory-capabilities.json"), "{ invalid json");
    expect(checkFactoryPlan(directory)).toEqual([
      expect.stringMatching(/^factory-capabilities\.json: SyntaxError:/u),
    ]);
  });
});
