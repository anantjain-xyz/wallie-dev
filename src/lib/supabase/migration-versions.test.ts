import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(currentDir, "../../../supabase/migrations");

describe("Supabase migration versions", () => {
  it("uses a unique version for every migration", () => {
    const migrationsByVersion = new Map<string, string[]>();

    for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"))) {
      const version = file.match(/^(\d{14})_/)?.[1];

      expect(version, `${file} must start with a 14-digit version`).toBeDefined();

      const files = migrationsByVersion.get(version!) ?? [];
      files.push(file);
      migrationsByVersion.set(version!, files);
    }

    const duplicates = [...migrationsByVersion.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => `${version}: ${files.join(", ")}`);

    expect(duplicates, "duplicate Supabase migration versions").toEqual([]);
  });
});
