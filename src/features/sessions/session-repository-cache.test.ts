// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { notifySessionRepositoriesChanged } from "@/features/sessions/session-repository-cache-events";
import {
  getSessionRepositorySnapshot,
  invalidateSessionRepositoryCache,
  loadSessionRepositories,
  resetSessionRepositoryCacheForTests,
  SESSION_REPOSITORY_CACHE_TTL_MS,
} from "@/features/sessions/session-repository-cache";

const key = { userId: "user-1", workspaceId: "workspace-1" };
const result = {
  defaultGithubRepositoryId: "repo-1",
  repositoryOptions: [{ fullName: "acme/app", id: "repo-1" }],
};

describe("session repository cache", () => {
  afterEach(() => {
    resetSessionRepositoryCacheForTests();
  });

  it("deduplicates an in-flight request and reuses a fresh result", async () => {
    const load = vi.fn(async () => result);

    const first = loadSessionRepositories(key, { load, now: 100 });
    const second = loadSessionRepositories(key, { load, now: 100 });

    await expect(Promise.all([first, second])).resolves.toEqual([result, result]);
    await expect(loadSessionRepositories(key, { load, now: 200 })).resolves.toBe(result);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not share results across workspaces or users", async () => {
    const load = vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
      defaultGithubRepositoryId: workspaceId,
      repositoryOptions: [{ fullName: `acme/${workspaceId}`, id: workspaceId }],
    }));

    await loadSessionRepositories(key, { load, now: 100 });
    await loadSessionRepositories(
      { userId: "user-1", workspaceId: "workspace-2" },
      { load, now: 100 },
    );
    expect(getSessionRepositorySnapshot(key).data).toMatchObject({
      defaultGithubRepositoryId: "workspace-1",
    });
    expect(
      getSessionRepositorySnapshot({ userId: "user-1", workspaceId: "workspace-2" }).data,
    ).toMatchObject({ defaultGithubRepositoryId: "workspace-2" });

    const nextUserKey = { userId: "user-2", workspaceId: "workspace-1" };
    await loadSessionRepositories(nextUserKey, { load, now: 100 });

    expect(load).toHaveBeenCalledTimes(3);
    expect(getSessionRepositorySnapshot(nextUserKey).data).toMatchObject({
      defaultGithubRepositoryId: "workspace-1",
    });
    expect(getSessionRepositorySnapshot(key).data).toBeNull();
  });

  it("serves stale data explicitly while revalidating", async () => {
    let resolveRefresh: ((value: typeof result) => void) | undefined;
    const load = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementationOnce(
        () =>
          new Promise<typeof result>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    await loadSessionRepositories(key, { load, now: 100 });

    const refresh = loadSessionRepositories(key, {
      load,
      now: 100 + SESSION_REPOSITORY_CACHE_TTL_MS,
    });

    expect(getSessionRepositorySnapshot(key)).toMatchObject({
      data: result,
      isRefreshing: true,
      isStale: true,
    });
    resolveRefresh?.(result);
    await refresh;
    expect(getSessionRepositorySnapshot(key)).toMatchObject({
      isRefreshing: false,
      isStale: false,
    });
  });

  it("marks only the changed workspace stale after settings invalidation", async () => {
    const load = vi.fn(async () => result);
    const otherKey = { userId: "user-1", workspaceId: "workspace-2" };
    await loadSessionRepositories(key, { load, now: 100 });
    await loadSessionRepositories(otherKey, { load, now: 100 });

    invalidateSessionRepositoryCache("workspace-1");

    expect(getSessionRepositorySnapshot(key).isStale).toBe(true);
    expect(getSessionRepositorySnapshot(otherKey).isStale).toBe(false);
  });

  it("receives repository settings invalidation events", async () => {
    const load = vi.fn(async () => result);
    await loadSessionRepositories(key, { load, now: 100 });

    notifySessionRepositoriesChanged("workspace-1");

    expect(getSessionRepositorySnapshot(key).isStale).toBe(true);
  });

  it("keeps stale options available when revalidation fails", async () => {
    const load = vi.fn().mockResolvedValueOnce(result).mockRejectedValueOnce(new Error("Offline"));
    await loadSessionRepositories(key, { load, now: 100 });

    await expect(
      loadSessionRepositories(key, {
        load,
        now: 100 + SESSION_REPOSITORY_CACHE_TTL_MS,
      }),
    ).rejects.toThrow("Offline");

    expect(getSessionRepositorySnapshot(key)).toMatchObject({
      data: result,
      error: "Offline",
      isRefreshing: false,
      isStale: true,
    });
  });
});
