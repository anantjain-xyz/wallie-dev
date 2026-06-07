import { describe, expect, it } from "vitest";

import { buildRepositoryOnboardingPlan } from "@/lib/repo-onboarding/planner";
import {
  DEFAULT_WALLIE_SKILLS,
  UPGRADABLE_WALLIE_LEGACY_FILES,
  WALLIE_AGENTS_INSTRUCTIONS,
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

  it("upgrades exact legacy Wallie-owned files without treating them as user edits", () => {
    const changedSkillNames = new Set(["commit", "pr-feedback", "screenshot"]);
    const changedSkills = DEFAULT_WALLIE_SKILLS.filter((skill) =>
      changedSkillNames.has(skill.name),
    );
    const currentByPath = new Map([
      ...changedSkills.map((skill) => [skill.path, skill.content] as const),
      [WALLIE_AGENTS_INSTRUCTIONS_PATH, WALLIE_AGENTS_INSTRUCTIONS] as const,
    ]);
    const plan = buildRepositoryOnboardingPlan({
      existingFiles: UPGRADABLE_WALLIE_LEGACY_FILES.map((file) => ({
        content: file.content,
        exists: true,
        path: file.path,
      })),
      skillVersion: WALLIE_SKILL_VERSION,
      skills: changedSkills,
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.filesToCreate.map((file) => file.path).sort()).toEqual(
      [...currentByPath.keys()].sort(),
    );
    expect(plan.filesToCreate).toEqual(
      expect.arrayContaining(
        [...currentByPath].map(([path, content]) => expect.objectContaining({ content, path })),
      ),
    );
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

  it("documents screenshot commits as temporary proof artifacts that must be reverted", () => {
    const screenshotSkill = DEFAULT_WALLIE_SKILLS.find((skill) => skill.name === "screenshot");
    expect(screenshotSkill).toBeDefined();
    const content = screenshotSkill!.content;

    expect(content).toContain("never be part of the final PR diff");
    expect(content).toContain("commit-SHA raw GitHub URLs");
    expect(content).toContain("git revert <screenshot-commit-sha>");
    expect(content).not.toContain("git push --force-with-lease");
    expect(WALLIE_AGENTS_INSTRUCTIONS).toContain("never leave them in the final PR diff");
  });

  it("documents PR feedback sweeps as bot and human review loops", () => {
    const prFeedbackSkill = DEFAULT_WALLIE_SKILLS.find((skill) => skill.name === "pr-feedback");
    expect(prFeedbackSkill).toBeDefined();
    const content = prFeedbackSkill!.content;

    expect(content).toContain("Top-level PR comments from bots and humans");
    expect(content).toContain("Inline review comments or threads from bots and humans");
    expect(content).toContain("failed check-run annotations");
    expect(content).toContain("check-runs/<check_run_id>/annotations");
    expect(content).toContain("repeat the sweep");
  });
});
