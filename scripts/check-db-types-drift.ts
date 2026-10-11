import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const generatedDatabaseTypesPath = "src/lib/supabase/database.types.ts";

export type DbTypesDriftResult = Readonly<{
  exitCode: number;
  messages: readonly string[];
}>;

/** Compare the applied schema projection without modifying the checked-in file. */
export function checkDbTypesDrift(projectDirectory = process.cwd()): DbTypesDriftResult {
  const typesPath = resolve(projectDirectory, generatedDatabaseTypesPath);
  if (!existsSync(typesPath)) {
    return {
      exitCode: 1,
      messages: [`Missing generated types file: ${generatedDatabaseTypesPath}`],
    };
  }
  const committed = readFileSync(typesPath, "utf8");
  if (!committed.includes("export type Database")) {
    return {
      exitCode: 1,
      messages: [`${generatedDatabaseTypesPath} is not a generated Database types file.`],
    };
  }

  let generated: string;
  try {
    generated = execFileSync("supabase", ["gen", "types", "typescript", "--local"], {
      cwd: projectDirectory,
      encoding: "utf8",
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch {
    return {
      exitCode: 1,
      messages: [
        "Could not generate local database types. Start Supabase with the committed migrations applied, then rerun pnpm db:types:check.",
      ],
    };
  }
  if (!generated.includes("export type Database")) {
    return { exitCode: 1, messages: ["Supabase returned no valid Database type projection."] };
  }
  if (generated !== committed) {
    return {
      exitCode: 1,
      messages: [
        `${generatedDatabaseTypesPath} differs from the applied local schema. Run pnpm db:types, review the diff, and commit the generated file.`,
      ],
    };
  }
  return { exitCode: 0, messages: ["Generated database types match the applied local schema."] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = checkDbTypesDrift(process.argv[2]);
  for (const message of result.messages) {
    if (result.exitCode) console.error(message);
    else console.log(message);
  }
  process.exitCode = result.exitCode;
}
