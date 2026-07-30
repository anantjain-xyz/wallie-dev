import { lstatSync, readFileSync, readdirSync, readlinkSync, type Dirent } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PIPELINE_VARIABLE_HELP } from "@/features/pipeline/editor-primitives";
import { SANDBOX_PROVIDER_OPTIONS } from "@/features/settings/sandbox-provider-section";
import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import { buildStageTemplateVariables } from "@/lib/prompt-templates";
import {
  DEFAULT_WALLIE_SKILLS,
  UPGRADABLE_WALLIE_LEGACY_FILES,
  WALLIE_AGENTS_INSTRUCTIONS,
} from "@/lib/repo-onboarding/skills";
import { SANDBOX_PROVIDER_CONTRACTS } from "@/lib/sandbox/provider-contract";
import { SANDBOX_PROVIDER_IDS } from "@/lib/sandbox/types";
import { parse } from "yaml";

type AdaptableField = "body" | "description" | "missing-projection" | "name" | "omission";

export type HarnessProjectionAdaptation = {
  expected?: string;
  field: AdaptableField;
  id: string;
  owner: string;
  projection: string;
  reason: string;
  value?: string;
};

export type HarnessProjectionDiagnostic = {
  message: string;
  owner: string;
  projection: string;
};

export type HarnessSkillProjection = {
  body: string;
  content: string;
  declaredName?: string;
  description: string | null;
  frontmatterKeys: string[];
  metadataAuthor: string | null;
  name: string | null;
  path: string;
  source: "generated-current" | "generated-legacy" | "repository";
};

export type HarnessProjectionSnapshot = {
  adaptations: HarnessProjectionAdaptation[];
  agentsInstructions: Array<{
    content: string;
    path: string;
    source: "generated-current" | "generated-legacy";
  }>;
  claudeSkillLinks: Array<{ path: string; target: string }>;
  generatedSkills: HarnessSkillProjection[];
  packageScripts: string[];
  promptVariables: {
    owner: string[];
    projection: string[];
  };
  providerInventories: Array<{ path: string; values: string[] }>;
  providerOwner: string[];
  repositorySkills: HarnessSkillProjection[];
};

const PROMPT_VARIABLE_OWNER = "buildStageTemplateVariables";
const PROMPT_VARIABLE_PROJECTION = "PIPELINE_VARIABLE_HELP";
const PROVIDER_INVENTORY_OWNER = "SANDBOX_PROVIDER_IDS";
const REQUIRED_FRONTMATTER_KEYS = ["description", "name"];
const PNPM_BUILTINS = new Set([
  "add",
  "approve-builds",
  "config",
  "create",
  "dlx",
  "env",
  "exec",
  "fetch",
  "import",
  "init",
  "install",
  "link",
  "list",
  "outdated",
  "patch",
  "prune",
  "publish",
  "remove",
  "run",
  "setup",
  "store",
  "uninstall",
  "unlink",
  "update",
  "why",
]);

const REPOSITORY_DETAIL_VARIANTS = new Set([
  "commit",
  "land",
  "pr-feedback",
  "pull",
  "push",
  "workpad",
]);

const PROMPT_HELP_OMISSIONS = [
  "repo.defaultBranch",
  "repo.fullName",
  "repo.name",
  "session.stageSlug",
] as const;

export function verifyHarnessProjectionSnapshot(
  snapshot: HarnessProjectionSnapshot,
): HarnessProjectionDiagnostic[] {
  const diagnostics: HarnessProjectionDiagnostic[] = [];
  const adaptationsByKey = new Map<string, HarnessProjectionAdaptation>();
  const usedAdaptations = new Set<string>();

  for (const adaptation of snapshot.adaptations) {
    const key = adaptationKey(adaptation);
    const existing = adaptationsByKey.get(key);
    if (existing) {
      diagnostics.push({
        message: `Harness projection adaptation "${adaptation.id}" duplicates "${existing.id}" for the same projection point (semantic owner: ${adaptation.owner}).`,
        owner: adaptation.owner,
        projection: adaptation.projection,
      });
      continue;
    }
    adaptationsByKey.set(key, adaptation);
  }

  const currentSkills = snapshot.generatedSkills.filter(
    (skill) => skill.source === "generated-current",
  );
  const legacySkills = snapshot.generatedSkills.filter(
    (skill) => skill.source === "generated-legacy",
  );
  const currentByName = uniqueSkillsByName(currentSkills, "DEFAULT_WALLIE_SKILLS", diagnostics);
  const repositoryByPath = uniqueSkillsByPath(snapshot.repositorySkills, diagnostics);

  for (const ownerSkill of currentSkills) {
    const ownerName = projectionOwnerName(ownerSkill);
    if (!ownerName) continue;
    const owner = skillOwner(ownerName);
    verifySkillShape(ownerSkill, owner, diagnostics);
    if (ownerSkill.declaredName !== ownerSkill.name) {
      diagnostics.push({
        message: `${owner} declares generated name "${ownerSkill.declaredName ?? "<missing>"}" but its frontmatter declares "${ownerSkill.name}" (semantic owner: ${owner}).`,
        owner,
        projection: ownerSkill.path,
      });
    }

    const expectedPath = `.agents/skills/${ownerName}/SKILL.md`;
    if (ownerSkill.path !== expectedPath) {
      diagnostics.push({
        message: `${owner} declares path "${ownerSkill.path}" instead of its owned projection "${expectedPath}" (semantic owner: ${owner}).`,
        owner,
        projection: ownerSkill.path,
      });
    }

    for (const projectionName of [ownerName, `symphony-${ownerName}`]) {
      const projectionPath = `.agents/skills/${projectionName}/SKILL.md`;
      const projection = repositoryByPath.get(projectionPath);
      if (!projection) {
        diagnostics.push({
          message: `${owner} is missing repository projection "${projectionPath}" (semantic owner: ${owner}).`,
          owner,
          projection: projectionPath,
        });
        continue;
      }
      verifySkillShape(projection, owner, diagnostics);
      compareSkillProjection(
        ownerSkill,
        projection,
        owner,
        adaptationsByKey,
        usedAdaptations,
        diagnostics,
      );
    }
  }

  for (const legacySkill of legacySkills) {
    verifySkillShape(
      legacySkill,
      legacySkill.name ? skillOwner(legacySkill.name) : legacySkill.path,
      diagnostics,
    );
    const ownerSkill = legacySkill.name ? currentByName.get(legacySkill.name) : undefined;
    if (!ownerSkill || !legacySkill.name) {
      const owner = legacySkill.name ? skillOwner(legacySkill.name) : legacySkill.path;
      diagnostics.push({
        message: `Generated legacy projection "${legacySkill.path}" has no current generated skill owner (semantic owner: ${owner}).`,
        owner,
        projection: legacySkill.path,
      });
      continue;
    }
    compareSkillProjection(
      ownerSkill,
      legacySkill,
      skillOwner(legacySkill.name),
      adaptationsByKey,
      usedAdaptations,
      diagnostics,
    );
  }

  for (const skill of snapshot.repositorySkills) {
    const directoryName = skill.path.split("/").at(-2) ?? skill.path;
    const ownerName = directoryName.startsWith("symphony-")
      ? directoryName.slice("symphony-".length)
      : directoryName;
    const externalOwner = skill.metadataAuthor !== null;
    const owner = externalOwner
      ? `external skill "${directoryName}" by ${skill.metadataAuthor}`
      : skillOwner(ownerName);

    verifySkillShape(skill, owner, diagnostics, externalOwner);
    if (skill.name !== directoryName) {
      diagnostics.push({
        message: `Repository manifest "${skill.path}" declares skill name "${skill.name ?? "<missing>"}" instead of directory-owned name "${directoryName}" (semantic owner: ${owner}).`,
        owner,
        projection: skill.path,
      });
    }
    if (!externalOwner && !currentByName.has(ownerName)) {
      diagnostics.push({
        message: `Repository manifest "${skill.path}" has no generated skill owner named "${ownerName}" (semantic owner: ${owner}).`,
        owner,
        projection: skill.path,
      });
    }
  }

  verifyClaudeSkillLinks(
    snapshot,
    currentSkills,
    repositoryByPath,
    adaptationsByKey,
    usedAdaptations,
    diagnostics,
  );
  verifyAgentsInstructions(snapshot, currentSkills, diagnostics);
  verifyReferencedCommands(snapshot, diagnostics);
  verifyInventory(
    snapshot.promptVariables.owner,
    snapshot.promptVariables.projection,
    PROMPT_VARIABLE_OWNER,
    PROMPT_VARIABLE_PROJECTION,
    adaptationsByKey,
    usedAdaptations,
    diagnostics,
  );
  for (const inventory of snapshot.providerInventories) {
    verifyInventory(
      snapshot.providerOwner,
      inventory.values,
      PROVIDER_INVENTORY_OWNER,
      inventory.path,
      adaptationsByKey,
      usedAdaptations,
      diagnostics,
    );
  }

  for (const adaptation of snapshot.adaptations) {
    if (usedAdaptations.has(adaptation.id)) continue;
    diagnostics.push({
      message: `Harness projection adaptation "${adaptation.id}" is unused; remove the stale allowance or restore its intentional variant (semantic owner: ${adaptation.owner}).`,
      owner: adaptation.owner,
      projection: adaptation.projection,
    });
  }

  return diagnostics;
}

export function discoverHarnessProjectionSnapshot(
  projectDirectory = process.cwd(),
): HarnessProjectionSnapshot {
  const generatedSkills = [
    ...DEFAULT_WALLIE_SKILLS.map((skill) =>
      parseSkillProjection(skill.content, skill.path, "generated-current", skill.name),
    ),
    ...UPGRADABLE_WALLIE_LEGACY_FILES.flatMap((file, index) =>
      file.path.endsWith("/SKILL.md")
        ? [
            parseSkillProjection(
              file.content,
              `UPGRADABLE_WALLIE_LEGACY_FILES[${index}]::${file.path}`,
              "generated-legacy",
            ),
          ]
        : [],
    ),
  ];
  const repositorySkills = discoverRepositorySkills(projectDirectory);
  const packageJson = JSON.parse(
    readFileSync(resolve(projectDirectory, "package.json"), "utf8"),
  ) as { scripts?: Record<string, unknown> };
  const packageScripts =
    packageJson.scripts && typeof packageJson.scripts === "object"
      ? Object.keys(packageJson.scripts)
      : [];
  const previousStageSlug = "<slug>";
  const variables = buildStageTemplateVariables({
    attemptFeedback: untrustedPromptValue("attempt.feedback", "feedback"),
    attemptNumber: 1,
    previousStages: {
      [previousStageSlug]: untrustedPromptValue(
        `artifact.previousStages.${previousStageSlug}`,
        "artifact",
      ),
    },
    repoDefaultBranch: untrustedPromptValue("repo.defaultBranch", "main"),
    repoFullName: untrustedPromptValue("repo.fullName", "acme/repo"),
    repoName: untrustedPromptValue("repo.name", "repo"),
    sessionPrompt: untrustedPromptValue("session.prompt", "prompt"),
    sessionTitle: untrustedPromptValue("session.title", "title"),
    stageSlug: trustedPromptValue("stage.slug", "build"),
  });
  const currentInstructions = [
    {
      content: WALLIE_AGENTS_INSTRUCTIONS,
      path: "WALLIE_AGENTS_INSTRUCTIONS",
      source: "generated-current" as const,
    },
  ];
  const legacyInstructions = UPGRADABLE_WALLIE_LEGACY_FILES.flatMap((file, index) =>
    file.path === "AGENTS.md"
      ? [
          {
            content: file.content,
            path: `UPGRADABLE_WALLIE_LEGACY_FILES[${index}]::AGENTS.md`,
            source: "generated-legacy" as const,
          },
        ]
      : [],
  );

  return {
    adaptations: buildOwnedAdaptations(generatedSkills),
    agentsInstructions: [...currentInstructions, ...legacyInstructions],
    claudeSkillLinks: discoverClaudeSkillLinks(projectDirectory),
    generatedSkills,
    packageScripts,
    promptVariables: {
      owner: flattenVariablePaths(variables),
      projection: PIPELINE_VARIABLE_HELP.map((variable) => variable.slice(2, -2)),
    },
    providerInventories: [
      {
        path: "SANDBOX_PROVIDER_CONTRACTS",
        values: Object.keys(SANDBOX_PROVIDER_CONTRACTS),
      },
      {
        path: "SANDBOX_PROVIDER_OPTIONS",
        values: SANDBOX_PROVIDER_OPTIONS.map((provider) => provider.id),
      },
    ],
    providerOwner: [...SANDBOX_PROVIDER_IDS],
    repositorySkills,
  };
}

export function verifyHarnessProjections(
  projectDirectory = process.cwd(),
): HarnessProjectionDiagnostic[] {
  return verifyHarnessProjectionSnapshot(discoverHarnessProjectionSnapshot(projectDirectory));
}

function discoverRepositorySkills(projectDirectory: string): HarnessSkillProjection[] {
  const skillsDirectory = resolve(projectDirectory, ".agents/skills");
  return safeReadDirectory(skillsDirectory).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const path = `.agents/skills/${entry.name}/SKILL.md`;
    try {
      return [
        parseSkillProjection(
          readFileSync(resolve(projectDirectory, path), "utf8"),
          path,
          "repository",
        ),
      ];
    } catch {
      return [
        {
          body: "",
          content: "",
          description: null,
          frontmatterKeys: [],
          metadataAuthor: null,
          name: null,
          path,
          source: "repository",
        },
      ];
    }
  });
}

function discoverClaudeSkillLinks(
  projectDirectory: string,
): Array<{ path: string; target: string }> {
  const skillsDirectory = resolve(projectDirectory, ".claude/skills");
  return safeReadDirectory(skillsDirectory).flatMap((entry) => {
    const absolutePath = resolve(skillsDirectory, entry.name);
    if (!lstatSync(absolutePath).isSymbolicLink()) {
      return [{ path: `.claude/skills/${entry.name}`, target: "<not-a-symlink>" }];
    }
    const target = relative(
      projectDirectory,
      resolve(dirname(absolutePath), readlinkSync(absolutePath)),
    )
      .split(sep)
      .join("/");
    return [{ path: `.claude/skills/${entry.name}`, target }];
  });
}

function safeReadDirectory(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function parseSkillProjection(
  content: string,
  path: string,
  source: HarnessSkillProjection["source"],
  declaredName?: string,
): HarnessSkillProjection {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  let frontmatter: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parse(match[1] ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      frontmatter = {};
    }
  }
  const metadata =
    frontmatter.metadata &&
    typeof frontmatter.metadata === "object" &&
    !Array.isArray(frontmatter.metadata)
      ? (frontmatter.metadata as Record<string, unknown>)
      : null;
  return {
    body: (match?.[2] ?? "").trim(),
    content,
    declaredName,
    description: typeof frontmatter.description === "string" ? frontmatter.description : null,
    frontmatterKeys: Object.keys(frontmatter).sort(),
    metadataAuthor: typeof metadata?.author === "string" ? metadata.author : null,
    name: typeof frontmatter.name === "string" ? frontmatter.name : null,
    path,
    source,
  };
}

function buildOwnedAdaptations(
  generatedSkills: HarnessSkillProjection[],
): HarnessProjectionAdaptation[] {
  const currentSkills = generatedSkills.filter(
    (skill): skill is HarnessSkillProjection & { name: string } =>
      skill.source === "generated-current" && skill.name !== null,
  );
  const adaptations: HarnessProjectionAdaptation[] = [];

  for (const skill of currentSkills) {
    const owner = skillOwner(skill.name);
    if (REPOSITORY_DETAIL_VARIANTS.has(skill.name)) {
      for (const field of ["body", "description"] as const) {
        adaptations.push({
          field,
          id: `repository-detail:${skill.name}:${field}`,
          owner,
          projection: `.agents/skills/${skill.name}/SKILL.md`,
          reason:
            "The repository skill carries Symphony orchestration detail while generated customer skills stay runner-agnostic.",
        });
      }
    }
    for (const field of ["body", "description", "name"] as const) {
      adaptations.push({
        expected: field === "name" ? `symphony-${skill.name}` : undefined,
        field,
        id: `symphony-runner:${skill.name}:${field}`,
        owner,
        projection: `.agents/skills/symphony-${skill.name}/SKILL.md`,
        reason:
          "The Symphony runner projection is intentionally prefixed and may carry runner-specific orchestration detail.",
      });
    }
  }

  for (const legacySkill of generatedSkills.filter(
    (skill): skill is HarnessSkillProjection & { name: string } =>
      skill.source === "generated-legacy" && skill.name !== null,
  )) {
    adaptations.push({
      field: "body",
      id: `legacy-generated:${legacySkill.path}:body`,
      owner: skillOwner(legacySkill.name),
      projection: legacySkill.path,
      reason:
        "An exact historical generated body remains recognized for safe upgrades without becoming the current generated skill.",
    });
  }

  adaptations.push({
    field: "missing-projection",
    id: "claude-runner:plain-screenshot-omitted",
    owner: skillOwner("screenshot"),
    projection: ".claude/skills/screenshot",
    reason:
      "Claude exposes the Symphony screenshot flow and intentionally omits the incompatible runner-agnostic alias.",
  });
  for (const variable of PROMPT_HELP_OMISSIONS) {
    adaptations.push({
      field: "omission",
      id: `prompt-help:curated:${variable}`,
      owner: PROMPT_VARIABLE_OWNER,
      projection: PROMPT_VARIABLE_PROJECTION,
      reason:
        "The editor suggests user-authored inputs while runtime-owned context remains available but intentionally unsuggested.",
      value: variable,
    });
  }
  return adaptations;
}

function uniqueSkillsByName(
  skills: HarnessSkillProjection[],
  projection: string,
  diagnostics: HarnessProjectionDiagnostic[],
): Map<string, HarnessSkillProjection> {
  const result = new Map<string, HarnessSkillProjection>();
  for (const skill of skills) {
    const name = projectionOwnerName(skill);
    if (!name) continue;
    if (result.has(name)) {
      const owner = skillOwner(name);
      diagnostics.push({
        message: `${projection} declares duplicate generated skill owner "${name}" (semantic owner: ${owner}).`,
        owner,
        projection,
      });
      continue;
    }
    result.set(name, skill);
  }
  return result;
}

function uniqueSkillsByPath(
  skills: HarnessSkillProjection[],
  diagnostics: HarnessProjectionDiagnostic[],
): Map<string, HarnessSkillProjection> {
  const result = new Map<string, HarnessSkillProjection>();
  for (const skill of skills) {
    if (result.has(skill.path)) {
      diagnostics.push({
        message: `Repository skill projection "${skill.path}" is declared more than once (semantic owner: repository skill discovery).`,
        owner: "repository skill discovery",
        projection: skill.path,
      });
      continue;
    }
    result.set(skill.path, skill);
  }
  return result;
}

function verifySkillShape(
  skill: HarnessSkillProjection,
  owner: string,
  diagnostics: HarnessProjectionDiagnostic[],
  allowsMetadata = false,
): void {
  if (![skill.name, skill.description, skill.body].every((value) => value?.trim())) {
    diagnostics.push({
      message: `Skill manifest "${skill.path}" must declare non-empty name, description, and body (semantic owner: ${owner}).`,
      owner,
      projection: skill.path,
    });
  }
  const allowedKeys = allowsMetadata
    ? [...REQUIRED_FRONTMATTER_KEYS, "metadata"].sort()
    : REQUIRED_FRONTMATTER_KEYS;
  const unknownKeys = skill.frontmatterKeys.filter((key) => !allowedKeys.includes(key));
  const missingKeys = REQUIRED_FRONTMATTER_KEYS.filter(
    (key) => !skill.frontmatterKeys.includes(key),
  );
  if (unknownKeys.length || missingKeys.length) {
    diagnostics.push({
      message: `Skill manifest "${skill.path}" frontmatter differs from its owned fields; missing [${missingKeys.join(", ")}], unknown [${unknownKeys.join(", ")}] (semantic owner: ${owner}).`,
      owner,
      projection: skill.path,
    });
  }
}

function compareSkillProjection(
  ownerSkill: HarnessSkillProjection,
  projection: HarnessSkillProjection,
  owner: string,
  adaptationsByKey: Map<string, HarnessProjectionAdaptation>,
  usedAdaptations: Set<string>,
  diagnostics: HarnessProjectionDiagnostic[],
): void {
  for (const field of ["name", "description", "body"] as const) {
    const ownerValue = ownerSkill[field];
    const projectionValue = projection[field];
    if (ownerValue === projectionValue) continue;
    const adaptation = adaptationsByKey.get(
      adaptationKey({ field, owner, projection: projection.path }),
    );
    if (!adaptation) {
      diagnostics.push({
        message: `Skill projection "${projection.path}" changes ${field} without an owned adaptation (semantic owner: ${owner}).`,
        owner,
        projection: projection.path,
      });
      continue;
    }
    if (adaptation.expected !== undefined && projectionValue !== adaptation.expected) {
      diagnostics.push({
        message: `Skill projection "${projection.path}" uses ${field} "${String(projectionValue)}" instead of adapted value "${adaptation.expected}" (semantic owner: ${owner}).`,
        owner,
        projection: projection.path,
      });
      continue;
    }
    usedAdaptations.add(adaptation.id);
  }
}

function verifyClaudeSkillLinks(
  snapshot: HarnessProjectionSnapshot,
  currentSkills: HarnessSkillProjection[],
  repositoryByPath: Map<string, HarnessSkillProjection>,
  adaptationsByKey: Map<string, HarnessProjectionAdaptation>,
  usedAdaptations: Set<string>,
  diagnostics: HarnessProjectionDiagnostic[],
): void {
  const linksByPath = new Map(snapshot.claudeSkillLinks.map((link) => [link.path, link]));
  const requiredNames = currentSkills.flatMap((skill) =>
    projectionOwnerName(skill)
      ? [projectionOwnerName(skill)!, `symphony-${projectionOwnerName(skill)!}`]
      : [],
  );
  for (const name of requiredNames) {
    const ownerName = name.startsWith("symphony-") ? name.slice("symphony-".length) : name;
    const owner = skillOwner(ownerName);
    const projection = `.claude/skills/${name}`;
    const link = linksByPath.get(projection);
    if (!link) {
      const adaptation = adaptationsByKey.get(
        adaptationKey({ field: "missing-projection", owner, projection }),
      );
      if (adaptation) {
        usedAdaptations.add(adaptation.id);
      } else {
        diagnostics.push({
          message: `${owner} is missing Claude skill projection "${projection}" (semantic owner: ${owner}).`,
          owner,
          projection,
        });
      }
      continue;
    }
    const expectedTarget = `.agents/skills/${name}`;
    if (link.target !== expectedTarget) {
      diagnostics.push({
        message: `Claude skill projection "${projection}" targets "${link.target}" instead of owner path "${expectedTarget}" (semantic owner: ${owner}).`,
        owner,
        projection,
      });
    }
  }
  for (const link of snapshot.claudeSkillLinks) {
    const name = link.path.split("/").at(-1) ?? link.path;
    const repositoryPath = `.agents/skills/${name}/SKILL.md`;
    if (!repositoryByPath.has(repositoryPath)) {
      diagnostics.push({
        message: `Claude skill projection "${link.path}" has no repository manifest owner at "${repositoryPath}" (semantic owner: repository skill discovery).`,
        owner: "repository skill discovery",
        projection: link.path,
      });
    }
  }
}

function verifyAgentsInstructions(
  snapshot: HarnessProjectionSnapshot,
  currentSkills: HarnessSkillProjection[],
  diagnostics: HarnessProjectionDiagnostic[],
): void {
  const expected = currentSkills.flatMap((skill) => {
    const name = projectionOwnerName(skill);
    return name ? [name] : [];
  });
  expected.sort();
  for (const instructions of snapshot.agentsInstructions) {
    if (instructions.source === "generated-legacy") continue;
    const inventory = /default workflow skills are ([^.]+)\./.exec(instructions.content)?.[1] ?? "";
    const actual = [...inventory.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).sort();
    compareExactInventory(
      expected,
      actual,
      "DEFAULT_WALLIE_SKILLS",
      instructions.path,
      diagnostics,
    );
  }
}

function verifyReferencedCommands(
  snapshot: HarnessProjectionSnapshot,
  diagnostics: HarnessProjectionDiagnostic[],
): void {
  const scripts = new Set(snapshot.packageScripts);
  for (const skill of [...snapshot.generatedSkills, ...snapshot.repositorySkills]) {
    const owner = skill.name
      ? skillOwner(
          skill.name.startsWith("symphony-") ? skill.name.slice("symphony-".length) : skill.name,
        )
      : skill.path;
    for (const command of referencedPnpmScripts(skill.content)) {
      if (scripts.has(command)) continue;
      diagnostics.push({
        message: `Skill projection "${skill.path}" references missing package script "pnpm ${command}" (semantic owner: ${owner}).`,
        owner,
        projection: skill.path,
      });
    }
  }
}

function referencedPnpmScripts(content: string): string[] {
  const scripts = new Set<string>();
  for (const match of content.matchAll(
    /\bpnpm(?:\s+--[\w-]+(?:=\S+)?)?\s+([\w:-]+)(?:\s+([\w:-]+))?/g,
  )) {
    const command = match[1]!;
    if (command === "run") {
      const script = match[2];
      if (script) scripts.add(script);
    } else if (!PNPM_BUILTINS.has(command)) {
      scripts.add(command);
    }
  }
  return [...scripts].sort();
}

function verifyInventory(
  ownerValues: string[],
  projectionValues: string[],
  owner: string,
  projection: string,
  adaptationsByKey: Map<string, HarnessProjectionAdaptation>,
  usedAdaptations: Set<string>,
  diagnostics: HarnessProjectionDiagnostic[],
): void {
  verifyInventoryDuplicates(ownerValues, "Semantic owner", owner, projection, diagnostics);
  verifyInventoryDuplicates(projectionValues, "Projection", owner, projection, diagnostics);
  const ownerSet = new Set(ownerValues);
  const projectionSet = new Set(projectionValues);
  for (const value of ownerSet) {
    if (projectionSet.has(value)) continue;
    const adaptation = adaptationsByKey.get(
      adaptationKey({ field: "omission", owner, projection, value }),
    );
    if (adaptation) {
      usedAdaptations.add(adaptation.id);
    } else {
      diagnostics.push({
        message: `Projection "${projection}" is missing "${value}" from its inventory (semantic owner: ${owner}).`,
        owner,
        projection,
      });
    }
  }
  for (const value of projectionSet) {
    if (ownerSet.has(value)) continue;
    diagnostics.push({
      message: `Projection "${projection}" declares unknown inventory value "${value}" (semantic owner: ${owner}).`,
      owner,
      projection,
    });
  }
}

function compareExactInventory(
  ownerValues: string[],
  projectionValues: string[],
  owner: string,
  projection: string,
  diagnostics: HarnessProjectionDiagnostic[],
): void {
  verifyInventoryDuplicates(ownerValues, "Semantic owner", owner, projection, diagnostics);
  verifyInventoryDuplicates(projectionValues, "Projection", owner, projection, diagnostics);
  const ownerSet = new Set(ownerValues);
  const projectionSet = new Set(projectionValues);
  for (const value of ownerSet) {
    if (!projectionSet.has(value)) {
      diagnostics.push({
        message: `Projection "${projection}" is missing "${value}" from its inventory (semantic owner: ${owner}).`,
        owner,
        projection,
      });
    }
  }
  for (const value of projectionSet) {
    if (!ownerSet.has(value)) {
      diagnostics.push({
        message: `Projection "${projection}" declares unknown inventory value "${value}" (semantic owner: ${owner}).`,
        owner,
        projection,
      });
    }
  }
}

function verifyInventoryDuplicates(
  values: string[],
  subject: "Projection" | "Semantic owner",
  owner: string,
  projection: string,
  diagnostics: HarnessProjectionDiagnostic[],
): void {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const [value, count] of counts) {
    if (count < 2) continue;
    diagnostics.push({
      message: `${subject} "${subject === "Projection" ? projection : owner}" repeats inventory value "${value}" (semantic owner: ${owner}).`,
      owner,
      projection,
    });
  }
}

function flattenVariablePaths(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flattenVariablePaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

function skillOwner(name: string): string {
  return `generated skill "${name}"`;
}

function projectionOwnerName(skill: HarnessSkillProjection): string | null {
  return skill.source === "generated-current" ? (skill.declaredName ?? skill.name) : skill.name;
}

function adaptationKey(
  adaptation: Pick<HarnessProjectionAdaptation, "field" | "owner" | "projection"> & {
    value?: string;
  },
): string {
  return [adaptation.owner, adaptation.projection, adaptation.field, adaptation.value ?? ""].join(
    "\0",
  );
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const diagnostics = verifyHarnessProjections();
  if (diagnostics.length === 0) {
    console.log(
      "Agent harness projections verified: discovered skills, guidance, commands, prompt variables, providers, and owned adaptations agree.",
    );
  } else {
    console.error("Agent harness projection drift detected:");
    for (const diagnostic of diagnostics) console.error(`- ${diagnostic.message}`);
    process.exitCode = 1;
  }
}
