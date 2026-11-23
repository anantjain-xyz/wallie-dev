import { describe, expect, it } from "vitest";

import type { ValidationPlan } from "@/lib/validation-evidence/contracts";
import { selectJoinValidationPlan } from "./join-validation-plan";

function commands(...keys: string[]): ValidationPlan {
  return {
    version: 1,
    commands: keys.map((key) => ({ key, command: `pnpm ${key}`, timeoutSeconds: 60, reports: [] })),
  };
}

describe("selectJoinValidationPlan", () => {
  it("retains the complete parent plan in its original execution order", () => {
    const plan = commands("setup", "test", "lint");
    expect(selectJoinValidationPlan([plan], ["lint", "test"])).toEqual(plan);
  });

  it("combines branch plans in an order that honors their setup and shared checks", () => {
    const first = commands("setup", "test", "lint");
    const second = commands("prepare-browser", "lint", "visual");
    expect(selectJoinValidationPlan([first, second], ["test", "visual"])).toEqual(
      commands("setup", "test", "prepare-browser", "lint", "visual"),
    );
  });

  it("blocks conflicting definitions for the same key", () => {
    const first = commands("test");
    const second = commands("test");
    second.commands[0].command = "pnpm boundary";
    expect(() => selectJoinValidationPlan([first, second], ["test"])).toThrow(
      "disagree on a validation check",
    );
  });

  it("blocks changes to any contributing plan's relative execution order", () => {
    expect(() =>
      selectJoinValidationPlan([commands("setup", "test"), commands("test", "setup")], ["test"]),
    ).toThrow("disagree on validation order");
  });

  it("blocks missing required validation even when the input plans are valid", () => {
    expect(() => selectJoinValidationPlan([commands("lint")], ["test"])).toThrow(
      "do not cover the parent's required validation",
    );
  });

  it("requires the exact browser evidence kind and retains its frozen check", () => {
    const plan: ValidationPlan = {
      version: 2,
      commands: commands("setup").commands,
      browser: [
        {
          key: "inspector",
          path: "/inspector",
          timeoutSeconds: 15,
          interactions: [],
          regionTestId: "inspector",
          excludedTestIds: [],
          evidence: [{ kind: "screenshot", required: true }],
        },
      ],
    };
    expect(selectJoinValidationPlan([plan], ["browser:screenshot:inspector"])).toEqual(plan);
    expect(() => selectJoinValidationPlan([plan], ["browser:video:inspector"])).toThrow(
      "do not cover the parent's required validation",
    );
  });
});
