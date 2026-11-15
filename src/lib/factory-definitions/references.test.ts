import { describe, expect, it } from "vitest";

import { resolveFactoryReference, supportsFactoryComponent } from "./references";

const workspaceId = "972ae71a-d497-492b-9684-ef9dee9d744d";
const repositoryId = "c8f9f432-6e75-461d-bf55-cc532655d5e1";
const otherRepositoryId = "d293329e-f58e-47a8-8337-5b31cec3315e";

describe("resolveFactoryReference", () => {
  it("prefers a tenant's exact UUID even when another eligible entry claims it as an alias", () => {
    const exact = { id: repositoryId, workspaceId };
    const alias = { id: otherRepositoryId, workspaceId, aliases: [repositoryId.toUpperCase()] };

    expect(
      resolveFactoryReference(
        [alias, exact],
        workspaceId.toUpperCase(),
        repositoryId.toUpperCase(),
      ),
    ).toEqual({
      ok: true,
      entry: exact,
    });
  });

  it("ignores references from other tenants and preserves exact alias spelling", () => {
    const local = { id: repositoryId, workspaceId, aliases: ["Acme/Workflows"] };
    const foreign = {
      id: otherRepositoryId,
      workspaceId: "2fa5336e-87a6-43ae-b744-5ac0015c0617",
      aliases: ["Acme/Workflows"],
    };

    expect(resolveFactoryReference([foreign, local], workspaceId, "Acme/Workflows")).toEqual({
      ok: true,
      entry: local,
    });
    expect(resolveFactoryReference([foreign, local], workspaceId, "acme/workflows")).toEqual({
      ok: false,
      code: "missing_reference",
    });
    expect(resolveFactoryReference([foreign, local], workspaceId, otherRepositoryId)).toEqual({
      ok: false,
      code: "missing_reference",
    });
  });

  it("rejects aliases with distinct targets and keeps non-UUID IDs case-sensitive", () => {
    const upper = { id: "Review", workspaceId, aliases: ["review"] };
    const lower = { id: "review", workspaceId, aliases: ["review"] };
    const alternate = { id: "Audit", workspaceId, aliases: ["review"] };

    expect(resolveFactoryReference([lower, upper], workspaceId, "Review")).toEqual({
      ok: true,
      entry: upper,
    });
    expect(resolveFactoryReference([upper, alternate], workspaceId, "review")).toEqual({
      ok: false,
      code: "ambiguous_reference",
    });
  });

  it("rejects duplicate catalog identities even when one record alone matches the alias", () => {
    const entries = [
      { id: repositoryId, workspaceId, aliases: ["First"] },
      { id: repositoryId.toUpperCase(), workspaceId, aliases: ["Second"] },
    ];
    for (const reference of [repositoryId, "Second"]) {
      expect(resolveFactoryReference(entries, workspaceId, reference)).toEqual({
        ok: false,
        code: "ambiguous_reference",
      });
    }
  });
});

describe("supportsFactoryComponent", () => {
  const entry = { id: "Screenshot", workspaceId };

  it("requires both provider constraints and distinguishes empty from absent lists", () => {
    expect(supportsFactoryComponent(entry, "codex", "e2b")).toBe(true);
    expect(
      supportsFactoryComponent(
        { ...entry, agentProviders: ["codex"], sandboxProviders: ["e2b"] },
        "codex",
        "e2b",
      ),
    ).toBe(true);
    expect(
      supportsFactoryComponent(
        { ...entry, agentProviders: ["claude-code"], sandboxProviders: ["e2b"] },
        "codex",
        "e2b",
      ),
    ).toBe(false);
    expect(supportsFactoryComponent({ ...entry, sandboxProviders: [] }, "codex", "e2b")).toBe(
      false,
    );
  });
});
