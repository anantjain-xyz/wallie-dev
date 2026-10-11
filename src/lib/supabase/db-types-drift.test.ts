import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: generate }));

import {
  checkDbTypesDrift,
  generatedDatabaseTypesPath,
} from "../../../scripts/check-db-types-drift";

const directories: string[] = [];
const types = "export type Database = { public: { Tables: {} } }\n";
function fixture(content: string | null = types) {
  const directory = mkdtempSync(join(tmpdir(), "wallie-types-"));
  directories.push(directory);
  if (content !== null) {
    const path = join(directory, generatedDatabaseTypesPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return directory;
}
afterEach(() => {
  generate.mockReset();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("generated database type comparison", () => {
  it("checks the real generator output without depending on Git history", () => {
    const directory = fixture();
    generate.mockReturnValue(types);
    expect(checkDbTypesDrift(directory).exitCode).toBe(0);
    expect(generate).toHaveBeenCalledWith(
      "supabase",
      ["gen", "types", "typescript", "--local"],
      expect.objectContaining({ cwd: directory }),
    );
  });

  it("rejects drift and leaves the committed projection untouched", () => {
    const directory = fixture();
    generate.mockReturnValue("export type Database = { public: { Tables: { new_table: {} } } }\n");
    expect(checkDbTypesDrift(directory).exitCode).toBe(1);
    expect(readFileSync(join(directory, generatedDatabaseTypesPath), "utf8")).toBe(types);
  });

  it.each([null, "", "unrelated content"])(
    "rejects a missing or invalid committed projection: %s",
    (content) => {
      expect(checkDbTypesDrift(fixture(content)).exitCode).toBe(1);
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it("fails closed when local schema generation is unavailable", () => {
    generate.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    expect(checkDbTypesDrift(fixture()).exitCode).toBe(1);
  });

  it("rejects empty generator output", () => {
    generate.mockReturnValue("");
    expect(checkDbTypesDrift(fixture()).exitCode).toBe(1);
  });
});
