import {
  DEFAULT_WALLIE_SKILLS,
  UPGRADABLE_WALLIE_LEGACY_FILES,
  WALLIE_AGENTS_INSTRUCTIONS,
  WALLIE_AGENTS_INSTRUCTIONS_PATH,
  wallieSkillManifestHash,
  type DefaultWallieSkill,
} from "@/lib/repo-onboarding/skills";
import type { RepositoryOnboardingConflict } from "@/lib/repo-onboarding/contracts";

export type ExistingRepositoryFile = {
  content: string | null;
  error?: string;
  exists: boolean;
  path: string;
};

export type RepositoryOnboardingFile = {
  content: string;
  path: string;
};

export type RepositoryOnboardingPlan = {
  conflicts: RepositoryOnboardingConflict[];
  filesToCreate: RepositoryOnboardingFile[];
  manifestHash: string;
  missingSkillCount: number;
  skillVersion: number;
};

function contentsEqual(left: string | null, right: string): boolean {
  return left === right || left?.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n");
}

function isUpgradeableLegacyWallieFile(path: string, content: string | null): boolean {
  return UPGRADABLE_WALLIE_LEGACY_FILES.some(
    (file) => file.path === path && contentsEqual(content, file.content),
  );
}

export function buildRepositoryOnboardingPlan(input: {
  existingFiles: readonly ExistingRepositoryFile[];
  skillVersion: number;
  skills?: readonly DefaultWallieSkill[];
}): RepositoryOnboardingPlan {
  const skills = input.skills ?? DEFAULT_WALLIE_SKILLS;
  const existing = new Map(input.existingFiles.map((file) => [file.path, file]));
  const conflicts: RepositoryOnboardingConflict[] = [];
  const filesToCreate: RepositoryOnboardingFile[] = [];
  let missingSkillCount = 0;

  for (const entry of skills) {
    const file = existing.get(entry.path);
    if (file?.error) {
      conflicts.push({
        message: file.error,
        path: entry.path,
        reason: "github_read_failed",
      });
      continue;
    }

    if (!file?.exists) {
      missingSkillCount += 1;
      filesToCreate.push({ content: entry.content, path: entry.path });
      continue;
    }

    if (!contentsEqual(file.content, entry.content)) {
      if (isUpgradeableLegacyWallieFile(entry.path, file.content)) {
        filesToCreate.push({ content: entry.content, path: entry.path });
        continue;
      }

      conflicts.push({
        message:
          "A skill file already exists with different content. Wallie will not overwrite user-edited skills.",
        path: entry.path,
        reason: "existing_skill_differs",
      });
    }
  }

  const instructions = existing.get(WALLIE_AGENTS_INSTRUCTIONS_PATH);
  if (instructions?.error) {
    conflicts.push({
      message: instructions.error,
      path: WALLIE_AGENTS_INSTRUCTIONS_PATH,
      reason: "github_read_failed",
    });
  }

  if (!instructions?.exists && !instructions?.error) {
    filesToCreate.push({
      content: WALLIE_AGENTS_INSTRUCTIONS,
      path: WALLIE_AGENTS_INSTRUCTIONS_PATH,
    });
  } else if (
    instructions?.exists &&
    !contentsEqual(instructions.content, WALLIE_AGENTS_INSTRUCTIONS) &&
    isUpgradeableLegacyWallieFile(WALLIE_AGENTS_INSTRUCTIONS_PATH, instructions.content)
  ) {
    filesToCreate.push({
      content: WALLIE_AGENTS_INSTRUCTIONS,
      path: WALLIE_AGENTS_INSTRUCTIONS_PATH,
    });
  }

  return {
    conflicts,
    filesToCreate,
    manifestHash: wallieSkillManifestHash(skills),
    missingSkillCount,
    skillVersion: input.skillVersion,
  };
}
