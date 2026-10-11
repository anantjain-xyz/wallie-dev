// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { notifySessionRepositoriesChanged } from "@/features/sessions/session-repository-cache-events";
import { SETTINGS_PIPELINE_CHANGED } from "@/features/settings/settings-island-events";
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
  pipelineId: "pipeline-1",
  repositoryOptions: [{ fullName: "acme/app", id: "repo-1" }],
  stageOptions: [],
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
      pipelineId: workspaceId,
      repositoryOptions: [{ fullName: `acme/${workspaceId}`, id: workspaceId }],
      stageOptions: [],
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

  it("invalidates cached creation options when their pipeline is saved", async () => {
    const load = vi.fn(async () => result);
    await loadSessionRepositories(key, { load, now: 100 });

    window.dispatchEvent(
      new CustomEvent(SETTINGS_PIPELINE_CHANGED, { detail: { id: "pipeline-1" } }),
    );

    expect(getSessionRepositorySnapshot(key).isStale).toBe(true);
  });

  it.each(["initial", "refresh"])(
    "revalidates an invalidated %s read before publishing it",
    async (mode) => {
      let resolveOld!: (value: typeof result) => void;
      let resolveFresh!: (value: typeof result) => void;
      const updated = { ...result, defaultGithubRepositoryId: "repo-2" };
      if (mode === "refresh") await loadSessionRepositories(key, { load: async () => result });
      const load = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<typeof result>((resolve) => {
              resolveOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<typeof result>((resolve) => {
              resolveFresh = resolve;
            }),
        );
      const pending = loadSessionRepositories(key, { load, force: true });
      invalidateSessionRepositoryCache(key.workspaceId);
      invalidateSessionRepositoryCache(key.workspaceId);
      resolveOld(result);
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      expect(getSessionRepositorySnapshot(key)).toMatchObject({
        data: mode === "initial" ? null : result,
        isStale: mode === "refresh",
      });
      const duplicate = loadSessionRepositories(key, { load });
      resolveFresh(updated);
      await expect(Promise.all([pending, duplicate])).resolves.toEqual([updated, updated]);
      expect(getSessionRepositorySnapshot(key)).toMatchObject({ data: updated, isStale: false });
      expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it("invalidates a pending first read when its pipeline is not known yet", async () => {
    let resolveOld!: (value: typeof result) => void;
    const updated = { ...result, pipelineId: "pipeline-2" };
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<typeof result>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(updated);
    const pending = loadSessionRepositories(key, { load });
    window.dispatchEvent(
      new CustomEvent(SETTINGS_PIPELINE_CHANGED, { detail: { id: "pipeline-1" } }),
    );
    resolveOld(result);
    await expect(pending).resolves.toEqual(updated);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not restore an old user's invalidated read after switching users", async () => {
    let resolveOld!: (value: typeof result) => void;
    const load = vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const pending = loadSessionRepositories(key, { load });
    invalidateSessionRepositoryCache(key.workspaceId);
    const nextKey = { ...key, userId: "user-2" };
    const updated = { ...result, defaultGithubRepositoryId: "other-user-repo" };
    await loadSessionRepositories(nextKey, { load: async () => updated });
    resolveOld(result);
    await pending;
    expect(load).toHaveBeenCalledTimes(1);
    expect(getSessionRepositorySnapshot(nextKey).data).toEqual(updated);
    expect(getSessionRepositorySnapshot(key).data).toBeNull();
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
