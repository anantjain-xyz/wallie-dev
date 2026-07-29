import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { parse } from "yaml";

type PackageJson = {
  scripts?: Record<string, string>;
};

type WorkflowStep = {
  "continue-on-error"?: unknown;
  if?: unknown;
  run?: unknown;
};

type WorkflowJob = {
  "continue-on-error"?: unknown;
  if?: unknown;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  on?: unknown;
};

type Profile = {
  job: string;
  name: string;
  requiredReferences: readonly string[];
  script: string;
  workflow: string;
};

type ClassifiedCheck = {
  classification: "environment-dependent" | "route-budget";
  job?: string;
  scripts: readonly string[];
  workflow?: string;
};

const profiles: readonly Profile[] = [
  {
    job: "lint-and-format",
    name: "fast",
    requiredReferences: ["verify:validation", "format:check", "lint", "typecheck"],
    script: "check:fast",
    workflow: ".github/workflows/lint-and-format.yml",
  },
  {
    job: "test",
    name: "full",
    requiredReferences: ["check:fast", "test"],
    script: "check",
    workflow: ".github/workflows/test.yml",
  },
];

const classifiedChecks: readonly ClassifiedCheck[] = [
  {
    classification: "route-budget",
    job: "route-budgets",
    scripts: ["build", "check:route-budgets"],
    workflow: ".github/workflows/test.yml",
  },
  {
    classification: "environment-dependent",
    scripts: [
      "analyze:authenticated-bundle",
      "db:types",
      "test:e2e:onboarding",
      "test:e2e:responsive",
      "test:e2e:session-prefetch",
      "test:benchmark:interaction",
      "test:benchmark:content-visibility",
    ],
  },
];

function repairMissingScript(script: string, context: string) {
  return `${context} references missing package script "${script}". Declare "${script}" in package.json#scripts or update the validation contract reference.`;
}

function readJson(projectDirectory: string, errors: string[]): PackageJson {
  const path = resolve(projectDirectory, "package.json");

  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch (error) {
    errors.push(
      `Could not read package.json. Restore valid JSON before running validation: ${String(error)}`,
    );
    return {};
  }
}

function readWorkflow(projectDirectory: string, path: string, errors: string[]): Workflow | null {
  try {
    return parse(readFileSync(resolve(projectDirectory, path), "utf8")) as Workflow;
  } catch (error) {
    errors.push(
      `Could not read ${path}. Restore a valid workflow before running validation: ${String(error)}`,
    );
    return null;
  }
}

function hasPullRequestTrigger(trigger: unknown) {
  if (trigger === "pull_request") return true;
  if (Array.isArray(trigger)) return trigger.includes("pull_request");
  return typeof trigger === "object" && trigger !== null && "pull_request" in trigger;
}

function packageScriptCalls(job: WorkflowJob) {
  return (job.steps ?? []).flatMap((step) => {
    if (typeof step.run !== "string") return [];
    const match = step.run.trim().match(/^pnpm(?:\s+run)?\s+([A-Za-z0-9:_-]+)$/);
    return match?.[1] ? [{ script: match[1], step }] : [];
  });
}

function packageScriptReferences(job: WorkflowJob) {
  return packageScriptCalls(job).map(({ script }) => script);
}

function composedPackageScriptReferences(command: string) {
  const references: string[] = [];
  for (const component of command.split("&&")) {
    const match = component.trim().match(/^pnpm(?:\s+run)?\s+([A-Za-z0-9:_-]+)$/);
    if (!match?.[1]) return null;
    references.push(match[1]);
  }
  return references;
}

function verifyRequiredExecutionControls(profile: Profile, job: WorkflowJob, errors: string[]) {
  const context = `${profile.workflow} job "${profile.job}"`;

  if (job.if !== undefined) {
    errors.push(
      `${context} must run unconditionally for pull requests. Remove the job-level "if" condition so "pnpm ${profile.script}" cannot be skipped.`,
    );
  }
  if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) {
    errors.push(
      `${context} must block pull requests when validation fails. Remove job-level "continue-on-error" or set it to false.`,
    );
  }

  const delegationSteps = packageScriptCalls(job).filter(({ script }) => script === profile.script);
  for (const { step } of delegationSteps) {
    if (step.if !== undefined) {
      errors.push(
        `${context} must run "pnpm ${profile.script}" unconditionally. Remove the validation step's "if" condition so the canonical profile cannot be skipped.`,
      );
    }
    if (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false) {
      errors.push(
        `${context} must treat "pnpm ${profile.script}" failures as blocking. Remove the validation step's "continue-on-error" or set it to false.`,
      );
    }
  }
}

function verifyWorkflowDelegation(
  projectDirectory: string,
  profile: Profile,
  scripts: Record<string, string>,
  errors: string[],
) {
  const workflow = readWorkflow(projectDirectory, profile.workflow, errors);
  if (!workflow) return;

  if (!hasPullRequestTrigger(workflow.on)) {
    errors.push(
      `${profile.workflow} must run on pull_request so the ${profile.name} validation profile is enforced for PRs.`,
    );
  }

  const job = workflow.jobs?.[profile.job];
  if (!job) {
    errors.push(
      `${profile.workflow} is missing required job "${profile.job}". Restore it and delegate to "pnpm ${profile.script}".`,
    );
    return;
  }

  verifyRequiredExecutionControls(profile, job, errors);

  const references = packageScriptReferences(job);
  if (references.length !== 1 || references[0] !== profile.script) {
    const found =
      references.length === 0 ? "none" : references.map((name) => `"${name}"`).join(", ");
    errors.push(
      `${profile.workflow} job "${profile.job}" must delegate validation exactly once to "pnpm ${profile.script}" (found package-script calls: ${found}). Replace duplicated or drifted validation commands with the canonical profile.`,
    );
  }

  for (const reference of references) {
    if (!(reference in scripts)) {
      errors.push(repairMissingScript(reference, `${profile.workflow} job "${profile.job}"`));
    }
  }
}

function verifyClassifiedCheck(
  projectDirectory: string,
  check: ClassifiedCheck,
  scripts: Record<string, string>,
  errors: string[],
) {
  const context = `${check.classification} classification`;
  for (const script of check.scripts) {
    if (!(script in scripts)) errors.push(repairMissingScript(script, context));
  }

  if (!check.workflow || !check.job) return;
  const workflow = readWorkflow(projectDirectory, check.workflow, errors);
  if (!workflow) return;
  const job = workflow.jobs?.[check.job];
  if (!job) {
    errors.push(
      `${check.workflow} is missing classified ${check.classification} job "${check.job}". Restore the job or update its validation-contract classification.`,
    );
    return;
  }

  const references = packageScriptReferences(job);
  if (
    references.length !== check.scripts.length ||
    references.some((reference, index) => reference !== check.scripts[index])
  ) {
    errors.push(
      `${check.workflow} job "${check.job}" is classified as ${check.classification} and must call ${check.scripts.map((script) => `"pnpm ${script}"`).join(" then ")}. Update the job or its explicit classification.`,
    );
  }
}

export function verifyValidationContract(projectDirectory = process.cwd()) {
  const errors: string[] = [];
  const packageJson = readJson(projectDirectory, errors);
  const scripts = packageJson.scripts ?? {};

  for (const profile of profiles) {
    if (!(profile.script in scripts)) {
      errors.push(repairMissingScript(profile.script, `${profile.name} validation profile`));
    } else {
      const references = composedPackageScriptReferences(scripts[profile.script]);
      if (!references) {
        errors.push(
          `Package script "${profile.script}" owns the ${profile.name} validation profile and must compose declared package scripts as "pnpm <script>" commands joined by "&&". Move inline commands into named scripts so the verifier can reconcile them with CI.`,
        );
      } else {
        for (const reference of references) {
          if (!(reference in scripts)) {
            errors.push(repairMissingScript(reference, `Package script "${profile.script}"`));
          }
        }
        for (const requiredReference of profile.requiredReferences) {
          if (!references.includes(requiredReference)) {
            errors.push(
              `Package script "${profile.script}" must include "pnpm ${requiredReference}" in the ${profile.name} validation profile. Add it to keep the required PR contract enforced.`,
            );
          }
        }
      }
    }

    verifyWorkflowDelegation(projectDirectory, profile, scripts, errors);
  }

  for (const check of classifiedChecks) {
    verifyClassifiedCheck(projectDirectory, check, scripts, errors);
  }

  return errors;
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const errors = verifyValidationContract();
  if (errors.length === 0) {
    console.log(
      "Validation contract verified: fast/full PR profiles delegate to package scripts; route-budget and environment-dependent checks remain classified.",
    );
  } else {
    console.error("Validation contract drift detected:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}
