import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Railway worker deployment", () => {
  it("redeploys when Cursor worker code changes", async () => {
    const config = JSON.parse(await readFile(resolve(process.cwd(), "railway.json"), "utf8")) as {
      build?: { watchPatterns?: string[] };
    };

    expect(config.build?.watchPatterns).toContain("src/lib/cursor/**");
  });
});
