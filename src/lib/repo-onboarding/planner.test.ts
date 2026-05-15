import { describe, expect, it } from "vitest";

import { buildRepositoryOnboardingPlan } from "@/lib/repo-onboarding/planner";
import {
  DEFAULT_WALLIE_SKILLS,
  WALLIE_AGENTS_INSTRUCTIONS_PATH,
  WALLIE_SKILL_VERSION,
} from "@/lib/repo-onboarding/skills";

describe("repository onboarding planner", () => {
  it("creates every default skill and AGENTS.md when files are missing", () => {
    const plan = buildRepositoryOnboardingPlan({
      existingFiles: [],
      skillVersion: WALLIE_SKILL_VERSION,
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.filesToCreate.map((file) => file.path).sort()).toEqual(
      [...DEFAULT_WALLIE_SKILLS.map((skill) => skill.path), WALLIE_AGENTS_INSTRUCTIONS_PATH].sort(),
    );
    expect(plan.missingSkillCount).toBe(DEFAULT_WALLIE_SKILLS.length);
  });

  it("does not overwrite existing skill files with different content", () => {
    const skill = DEFAULT_WALLIE_SKILLS[0]!;
    const plan = buildRepositoryOnboardingPlan({
      existingFiles: [{ content: "user edited", exists: true, path: skill.path }],
      skillVersion: WALLIE_SKILL_VERSION,
      skills: [skill],
    });

    expect(plan.filesToCreate.map((file) => file.path)).toEqual([WALLIE_AGENTS_INSTRUCTIONS_PATH]);
    expect(plan.conflicts).toEqual([
      {
        message:
          "A skill file already exists with different content. Wallie will not overwrite user-edited skills.",
        path: skill.path,
        reason: "existing_skill_differs",
      },
    ]);
  });

  it("treats matching skill files as already installed", () => {
    const skill = DEFAULT_WALLIE_SKILLS[0]!;
    const plan = buildRepositoryOnboardingPlan({
      existingFiles: [
        { content: skill.content, exists: true, path: skill.path },
        { content: "existing instructions", exists: true, path: WALLIE_AGENTS_INSTRUCTIONS_PATH },
      ],
      skillVersion: WALLIE_SKILL_VERSION,
      skills: [skill],
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.filesToCreate).toEqual([]);
    expect(plan.missingSkillCount).toBe(0);
  });

  it("surfaces AGENTS.md read failures as onboarding conflicts", () => {
    const skill = DEFAULT_WALLIE_SKILLS[0]!;
    const plan = buildRepositoryOnboardingPlan({
      existingFiles: [
        { content: skill.content, exists: true, path: skill.path },
        {
          content: null,
          error: "GitHub read failed",
          exists: false,
          path: WALLIE_AGENTS_INSTRUCTIONS_PATH,
        },
      ],
      skillVersion: WALLIE_SKILL_VERSION,
      skills: [skill],
    });

    expect(plan.filesToCreate).toEqual([]);
    expect(plan.conflicts).toEqual([
      {
        message: "GitHub read failed",
        path: WALLIE_AGENTS_INSTRUCTIONS_PATH,
        reason: "github_read_failed",
      },
    ]);
  });
});
