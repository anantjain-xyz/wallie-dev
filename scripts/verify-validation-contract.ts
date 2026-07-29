import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { parse } from "yaml";

type PackageJson = {
  scripts?: unknown;
};

type ExpectedWorkflow = {
  delegation: string;
  expected: object;
  path: string;
};

const expectedScripts = {
  "verify:validation": "tsx scripts/verify-validation-contract.ts",
  "format:check": "prettier --check .",
  lint: "eslint . --max-warnings=0",
  typecheck: "tsc --noEmit",
  "check:migration-safety": "tsx scripts/check-migration-safety.ts",
  "check:privileged-imports": "tsx scripts/verify-privileged-imports.ts",
  test: "vitest run",
  "check:fast":
    "pnpm verify:validation && pnpm format:check && pnpm lint && pnpm typecheck && pnpm check:migration-safety && pnpm check:privileged-imports",
  check: "pnpm check:fast && pnpm test",
} as const;

const classifiedScripts = {
  "route-budget": ["build", "check:route-budgets"],
  "environment-dependent": [
    "analyze:authenticated-bundle",
    "db:types",
    "test:e2e:onboarding",
    "test:e2e:responsive",
    "test:e2e:session-prefetch",
    "test:benchmark:interaction",
    "test:benchmark:content-visibility",
  ],
} as const;

const triggers = {
  push: { branches: ["main"] },
  pull_request: { branches: ["main"] },
};

const setupSteps = [
  {
    name: "Check out repository",
    uses: "actions/checkout@v4",
    with: { "fetch-depth": 0 },
  },
  {
    name: "Set up pnpm",
    uses: "pnpm/action-setup@v4",
    with: { version: "10.15.0" },
  },
  {
    name: "Set up Node.js",
    uses: "actions/setup-node@v4",
    with: {
      "node-version": "22.13.0",
      cache: "pnpm",
    },
  },
  {
    name: "Install dependencies",
    run: "pnpm install --frozen-lockfile",
  },
];

const expectedWorkflows: readonly ExpectedWorkflow[] = [
  {
    delegation: "pnpm check:fast",
    expected: {
      name: "Lint and Format",
      on: triggers,
      permissions: { contents: "read" },
      jobs: {
        "lint-and-format": {
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 10,
          steps: [
            ...setupSteps,
            {
              name: "Run fast validation",
              run: "pnpm check:fast",
            },
          ],
        },
      },
    },
    path: ".github/workflows/lint-and-format.yml",
  },
  {
    delegation: "pnpm check",
    expected: {
      name: "Test",
      on: triggers,
      permissions: { contents: "read" },
      jobs: {
        test: {
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 10,
          steps: [
            ...setupSteps,
            {
              name: "Run full validation",
              run: "pnpm check",
            },
          ],
        },
        "route-budgets": {
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 15,
          steps: [
            ...setupSteps,
            {
              name: "Build production route diagnostics",
              run: "pnpm build",
            },
            {
              name: "Enforce route bundle ceilings",
              run: "pnpm check:route-budgets",
            },
          ],
        },
      },
    },
    path: ".github/workflows/test.yml",
  },
];

function hasOwn(object: object, property: string) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function readPackageScripts(projectDirectory: string, errors: string[]) {
  const packagePath = resolve(projectDirectory, "package.json");

  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    if (
      typeof packageJson.scripts !== "object" ||
      packageJson.scripts === null ||
      Array.isArray(packageJson.scripts)
    ) {
      errors.push(
        "package.json#scripts must be an object. Restore the declared validation scripts before running validation.",
      );
      return {};
    }
    return packageJson.scripts as Record<string, unknown>;
  } catch (error) {
    errors.push(
      `Could not read package.json. Restore valid JSON before running validation: ${String(error)}`,
    );
    return {};
  }
}

function verifyExpectedScripts(scripts: Record<string, unknown>, errors: string[]) {
  for (const [name, expectedCommand] of Object.entries(expectedScripts)) {
    if (!hasOwn(scripts, name)) {
      errors.push(
        `Validation contract references missing package script "${name}". Restore "${name}" in package.json#scripts with command "${expectedCommand}".`,
      );
      continue;
    }

    if (scripts[name] !== expectedCommand) {
      errors.push(
        `Package script "${name}" drifted from the approved validation contract. Restore its exact non-mutating command: "${expectedCommand}".`,
      );
    }
  }
}

function verifyClassifiedScripts(scripts: Record<string, unknown>, errors: string[]) {
  for (const [classification, names] of Object.entries(classifiedScripts)) {
    for (const name of names) {
      if (!hasOwn(scripts, name)) {
        errors.push(
          `${classification} validation references missing package script "${name}". Restore "${name}" in package.json#scripts or deliberately update its explicit classification.`,
        );
      }
    }
  }
}

function verifyExpectedWorkflows(projectDirectory: string, errors: string[]) {
  for (const workflow of expectedWorkflows) {
    let actual: unknown;

    try {
      actual = parse(readFileSync(resolve(projectDirectory, workflow.path), "utf8"));
    } catch (error) {
      errors.push(
        `Could not read ${workflow.path}. Restore the approved workflow before running validation: ${String(error)}`,
      );
      continue;
    }

    if (!isDeepStrictEqual(actual, workflow.expected)) {
      errors.push(
        `${workflow.path} drifted from its approved exact shape. Restore the direct "${workflow.delegation}" delegation and approved trigger, permissions, job, and step controls; update the explicit contract only when that required check intentionally changes.`,
      );
    }
  }
}

export function verifyValidationContract(projectDirectory = process.cwd()) {
  const errors: string[] = [];
  const scripts = readPackageScripts(projectDirectory, errors);

  verifyExpectedScripts(scripts, errors);
  verifyClassifiedScripts(scripts, errors);
  verifyExpectedWorkflows(projectDirectory, errors);

  return errors;
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const errors = verifyValidationContract();
  if (errors.length === 0) {
    console.log(
      "Validation contract verified: exact fast/full PR profiles match CI; route-budget and environment-dependent checks remain explicitly classified.",
    );
  } else {
    console.error("Validation contract drift detected:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}
