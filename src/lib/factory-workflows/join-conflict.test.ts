import { expect, it, vi } from "vitest";

import { readJoinConflict, retainJoinConflict } from "./join-conflict";

const scope = {
  workspaceId: "6520abcd-0000-4000-8000-000000000001",
  rootSessionId: "6520abcd-0000-4000-8000-000000000002",
  joinId: "6520abcd-0000-4000-8000-000000000003",
  runId: "6520abcd-0000-4000-8000-000000000004",
};

it("uses one canonical storage path and exact scope while bounding the settlement detail", async () => {
  const paths = Array.from({ length: 18 }, (_, index) => `src/${"a".repeat(490)}-${index}.ts`);
  const objects = new Map<string, Blob>();
  const upload = vi.fn(async (path: string, bytes: Buffer) => {
    objects.set(path, new Blob([Uint8Array.from(bytes)]));
  });
  const download = vi.fn(async (path: string) => objects.get(path) ?? null);
  const signal = AbortSignal.timeout(5_000);
  const canonical = await retainJoinConflict(
    { upload, download },
    scope,
    {
      kind: "conflict",
      edgeId: "run.required",
      incomingSha: "a".repeat(40),
      integratedThroughSha: "b".repeat(40),
      paths,
      pathsTruncated: false,
    },
    signal,
  );
  const uppercase = {
    workspaceId: scope.workspaceId.toUpperCase(),
    rootSessionId: scope.rootSessionId.toUpperCase(),
    joinId: scope.joinId.toUpperCase(),
    runId: scope.runId.toUpperCase(),
  };
  const restored = await readJoinConflict({ download }, uppercase, canonical.reportSha256, signal);
  expect(restored.scope).toEqual(scope);
  expect(restored.paths).toEqual(paths.slice(0, canonical.paths.length));
  expect(restored.paths).toEqual(canonical.paths);
  expect(restored.pathsTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(canonical))).toBeLessThan(8_192);
  const expectedPath = `${Object.values(scope).join("/")}/${canonical.reportSha256}.json`;
  expect(upload).toHaveBeenCalledExactlyOnceWith(expectedPath, expect.any(Buffer), signal);
  expect(download).toHaveBeenLastCalledWith(expectedPath, signal);
});
