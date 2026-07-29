import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  verifyHarnessProjections,
  verifyHarnessProjectionSnapshot,
  type HarnessProjectionAdaptation,
  type HarnessProjectionSnapshot,
  type HarnessSkillProjection,
} from "../../../scripts/verify-harness-projections";

const fixturesDirectory = fileURLToPath(
  new URL("../../../test/fixtures/harness-projections", import.meta.url),
);

type FixtureMutation =
  | {
      adaptation: HarnessProjectionAdaptation;
      op: "addAdaptation";
    }
  | {
      op: "addRepositorySkill";
      skill: HarnessSkillProjection;
    }
  | {
      op: "patchRepositorySkill";
      patch: Partial<HarnessSkillProjection>;
      path: string;
    }
  | {
      op: "removeRepositorySkill";
      path: string;
    };

type ProjectionCase = {
  expectedDiagnostics: string[];
  mutations: FixtureMutation[];
  name: string;
};

function readJsonFixture<T>(name: string): T {
  return JSON.parse(readFileSync(`${fixturesDirectory}/${name}`, "utf8")) as T;
}

function applyMutations(
  baseline: HarnessProjectionSnapshot,
  mutations: FixtureMutation[],
): HarnessProjectionSnapshot {
  const snapshot = structuredClone(baseline);
  for (const mutation of mutations) {
    if (mutation.op === "addAdaptation") {
      snapshot.adaptations.push(mutation.adaptation);
    } else if (mutation.op === "addRepositorySkill") {
      snapshot.repositorySkills.push(mutation.skill);
    } else if (mutation.op === "patchRepositorySkill") {
      const skill = snapshot.repositorySkills.find((candidate) => candidate.path === mutation.path);
      if (!skill) throw new Error(`Fixture skill not found: ${mutation.path}`);
      Object.assign(skill, mutation.patch);
    } else {
      snapshot.repositorySkills = snapshot.repositorySkills.filter(
        (skill) => skill.path !== mutation.path,
      );
    }
  }
  return snapshot;
}

describe("agent harness projection verifier fixtures", () => {
  const baseline = readJsonFixture<HarnessProjectionSnapshot>("passing.json");
  const cases = readJsonFixture<ProjectionCase[]>("cases.json");

  for (const fixture of cases) {
    it(fixture.name, () => {
      const diagnostics = verifyHarnessProjectionSnapshot(
        applyMutations(baseline, fixture.mutations),
      ).map((diagnostic) => diagnostic.message);

      if (fixture.expectedDiagnostics.length === 0) {
        expect(diagnostics).toEqual([]);
      } else {
        expect(diagnostics).toEqual(expect.arrayContaining(fixture.expectedDiagnostics));
      }
    });
  }
});

describe("agent harness projection verifier repository discovery", () => {
  it("reconciles the checked-in repository projections", () => {
    expect(verifyHarnessProjections()).toEqual([]);
  });
});
