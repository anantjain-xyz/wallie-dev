import { describe, expect, it } from "vitest";

import { inferRepositoryProfileFromFiles, type RepositoryInferenceFile } from "./infer";

function file(path: string, content = ""): RepositoryInferenceFile {
  return { content, path };
}

describe("inferRepositoryProfileFromFiles", () => {
  it("infers a Next.js pnpm repository from package metadata and lockfiles", () => {
    const profile = inferRepositoryProfileFromFiles([
      file(
        "package.json",
        JSON.stringify({
          packageManager: "pnpm@10.15.0",
          scripts: { build: "next build", test: "vitest run" },
          dependencies: { next: "16.2.1", react: "19.2.4" },
          devDependencies: { typescript: "^5" },
        }),
      ),
      file("pnpm-lock.yaml"),
      file("next.config.ts"),
      file(".env.example", "NEXT_PUBLIC_SUPABASE_URL=\n# ignored\nSUPABASE_SECRET_KEY=secret\n"),
    ]);

    expect(profile.packageManager).toBe("pnpm");
    expect(profile.languageHints).toEqual(["javascript", "typescript"]);
    expect(profile.frameworkHints).toContain("next");
    expect(profile.installCommand).toBe("pnpm install");
    expect(profile.buildCommand).toBe("pnpm build");
    expect(profile.testCommand).toBe("pnpm test");
    expect(profile.envKeySuggestions).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
    expect(profile.inferenceConfidence).toBe("high");
  });

  it("infers npm commands from package-lock", () => {
    const profile = inferRepositoryProfileFromFiles([
      file("package.json", JSON.stringify({ scripts: { build: "vite build", test: "vitest" } })),
      file("package-lock.json"),
    ]);

    expect(profile.packageManager).toBe("npm");
    expect(profile.installCommand).toBe("npm install");
    expect(profile.buildCommand).toBe("npm run build");
    expect(profile.testCommand).toBe("npm test");
  });

  it("infers yarn commands from yarn.lock", () => {
    const profile = inferRepositoryProfileFromFiles([
      file("package.json", JSON.stringify({ scripts: { build: "vite build", test: "vitest" } })),
      file("yarn.lock"),
    ]);

    expect(profile.packageManager).toBe("yarn");
    expect(profile.installCommand).toBe("yarn install");
    expect(profile.buildCommand).toBe("yarn build");
    expect(profile.testCommand).toBe("yarn test");
  });

  it("infers bun commands from bun lockfiles", () => {
    const profile = inferRepositoryProfileFromFiles([
      file("package.json", JSON.stringify({ scripts: { build: "vite build", test: "bun test" } })),
      file("bun.lockb"),
    ]);

    expect(profile.packageManager).toBe("bun");
    expect(profile.installCommand).toBe("bun install");
    expect(profile.buildCommand).toBe("bun run build");
    expect(profile.testCommand).toBe("bun run test");
  });

  it("infers Python requirements and pytest", () => {
    const profile = inferRepositoryProfileFromFiles([
      file("requirements.txt", "Django==5.0\npytest>=8\n"),
    ]);

    expect(profile.packageManager).toBe("pip");
    expect(profile.languageHints).toEqual(["python"]);
    expect(profile.installCommand).toBe("pip install -r requirements.txt");
    expect(profile.testCommand).toBe("pytest");
    expect(profile.inferenceConfidence).toBe("high");
  });

  it("infers Python uv and poetry repositories", () => {
    const uv = inferRepositoryProfileFromFiles([
      file("pyproject.toml", "[project]\nname = 'app'\n"),
      file("uv.lock"),
    ]);
    const poetry = inferRepositoryProfileFromFiles([
      file("pyproject.toml", "[tool.pytest.ini_options]\n"),
      file("poetry.lock"),
    ]);

    expect(uv.packageManager).toBe("uv");
    expect(uv.installCommand).toBe("uv sync");
    expect(poetry.packageManager).toBe("poetry");
    expect(poetry.installCommand).toBe("poetry install");
    expect(poetry.testCommand).toBe("pytest");
  });

  it("infers Go repositories", () => {
    const profile = inferRepositoryProfileFromFiles([file("go.mod", "module example.com/app\n")]);

    expect(profile.packageManager).toBe("go");
    expect(profile.languageHints).toEqual(["go"]);
    expect(profile.installCommand).toBe("go mod download");
    expect(profile.testCommand).toBe("go test ./...");
  });

  it("infers Rust repositories", () => {
    const profile = inferRepositoryProfileFromFiles([
      file("Cargo.toml", "[package]\nname='app'\n"),
    ]);

    expect(profile.packageManager).toBe("cargo");
    expect(profile.languageHints).toEqual(["rust"]);
    expect(profile.installCommand).toBe("cargo fetch");
    expect(profile.testCommand).toBe("cargo test");
  });

  it("keeps unknown repositories low confidence", () => {
    const profile = inferRepositoryProfileFromFiles([file("README.md", "# App\n")]);

    expect(profile.packageManager).toBeNull();
    expect(profile.languageHints).toEqual([]);
    expect(profile.installCommand).toBeNull();
    expect(profile.inferenceConfidence).toBe("low");
  });

  it("parses env examples as key names only", () => {
    const profile = inferRepositoryProfileFromFiles([
      file(".env.example", "export API_KEY=super-secret\nINVALID-KEY=value\nEMPTY=\n"),
      file(".env.sample", "API_KEY=other\nDATABASE_URL=postgres://secret\n"),
    ]);

    expect(profile.envKeySuggestions).toEqual(["API_KEY", "EMPTY", "DATABASE_URL"]);
  });
});
