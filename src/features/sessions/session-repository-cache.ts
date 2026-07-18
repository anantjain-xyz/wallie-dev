"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  loadSessionRepositoryOptionsFromClient,
  type SessionRepositoryOptionsResult,
} from "@/features/sessions/client";
import {
  SESSION_REPOSITORIES_CHANGED_EVENT,
  type SessionRepositoriesChangedDetail,
} from "@/features/sessions/session-repository-cache-events";

export const SESSION_REPOSITORY_CACHE_TTL_MS = 30_000;

export type SessionRepositoryCacheKey = {
  userId: string;
  workspaceId: string;
};

export type SessionRepositorySnapshot = {
  data: SessionRepositoryOptionsResult | null;
  error: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  isStale: boolean;
};

type SessionRepositoryLoader = (input: {
  workspaceId: string;
}) => Promise<SessionRepositoryOptionsResult>;

type CacheEntry = {
  key: SessionRepositoryCacheKey;
  listeners: Set<() => void>;
  promise: Promise<SessionRepositoryOptionsResult> | null;
  snapshot: SessionRepositorySnapshot;
  updatedAt: number;
};

const EMPTY_SNAPSHOT: SessionRepositorySnapshot = {
  data: null,
  error: null,
  isLoading: false,
  isRefreshing: false,
  isStale: false,
};

const entries = new Map<string, CacheEntry>();
let activeUserId: string | null = null;
let invalidationListenerAttached = false;

function serializeKey(key: SessionRepositoryCacheKey) {
  return `${key.userId}:${key.workspaceId}`;
}

function scopeCacheToUser(userId: string) {
  if (activeUserId && activeUserId !== userId) entries.clear();
  activeUserId = userId;
}

function createEntry(key: SessionRepositoryCacheKey): CacheEntry {
  return {
    key,
    listeners: new Set(),
    promise: null,
    snapshot: EMPTY_SNAPSHOT,
    updatedAt: 0,
  };
}

function getEntry(key: SessionRepositoryCacheKey) {
  const serializedKey = serializeKey(key);
  let entry = entries.get(serializedKey);
  if (!entry) {
    entry = createEntry(key);
    entries.set(serializedKey, entry);
  }
  return entry;
}

function publish(entry: CacheEntry, snapshot: SessionRepositorySnapshot) {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) listener();
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to load repositories.";
}

function ensureInvalidationListener() {
  if (invalidationListenerAttached || typeof window === "undefined") return;

  window.addEventListener(SESSION_REPOSITORIES_CHANGED_EVENT, handleRepositoriesChanged);
  invalidationListenerAttached = true;
}

function handleRepositoriesChanged(event: Event) {
  const workspaceId = (event as CustomEvent<SessionRepositoriesChangedDetail>).detail?.workspaceId;
  if (workspaceId) invalidateSessionRepositoryCache(workspaceId);
}

export function getSessionRepositorySnapshot(key: SessionRepositoryCacheKey) {
  return getEntry(key).snapshot;
}

export function loadSessionRepositories(
  key: SessionRepositoryCacheKey,
  options: {
    force?: boolean;
    load?: SessionRepositoryLoader;
    now?: number;
  } = {},
): Promise<SessionRepositoryOptionsResult> {
  ensureInvalidationListener();
  scopeCacheToUser(key.userId);
  const entry = getEntry(key);
  const now = options.now ?? Date.now();
  const isFresh =
    entry.snapshot.data !== null && now - entry.updatedAt < SESSION_REPOSITORY_CACHE_TTL_MS;

  if (!options.force && isFresh) {
    return Promise.resolve(entry.snapshot.data!);
  }

  if (entry.promise) return entry.promise;

  const hasData = entry.snapshot.data !== null;
  publish(entry, {
    data: entry.snapshot.data,
    error: null,
    isLoading: !hasData,
    isRefreshing: hasData,
    isStale: hasData,
  });

  const load = options.load ?? loadSessionRepositoryOptionsFromClient;
  const promise = load({ workspaceId: key.workspaceId })
    .then((data) => {
      entry.updatedAt = options.now ?? Date.now();
      publish(entry, {
        data,
        error: null,
        isLoading: false,
        isRefreshing: false,
        isStale: false,
      });
      return data;
    })
    .catch((error: unknown) => {
      publish(entry, {
        data: entry.snapshot.data,
        error: errorMessage(error),
        isLoading: false,
        isRefreshing: false,
        isStale: entry.snapshot.data !== null,
      });
      throw error;
    })
    .finally(() => {
      entry.promise = null;
    });

  entry.promise = promise;
  return promise;
}

export function preloadSessionRepositories(key: SessionRepositoryCacheKey) {
  return loadSessionRepositories(key);
}

export function retrySessionRepositories(key: SessionRepositoryCacheKey) {
  return loadSessionRepositories(key, { force: true });
}

export function invalidateSessionRepositoryCache(workspaceId: string) {
  for (const entry of entries.values()) {
    if (entry.key.workspaceId !== workspaceId) continue;

    entry.updatedAt = 0;
    publish(entry, {
      ...entry.snapshot,
      error: null,
      isRefreshing: entry.listeners.size > 0,
      isStale: entry.snapshot.data !== null,
    });

    if (entry.listeners.size > 0) {
      void loadSessionRepositories(entry.key).catch(() => undefined);
    }
  }
}

function subscribe(key: SessionRepositoryCacheKey, listener: () => void) {
  const entry = getEntry(key);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

export function useSessionRepositories(key: SessionRepositoryCacheKey) {
  scopeCacheToUser(key.userId);
  const serializedKey = serializeKey(key);
  const subscribeToKey = useCallback(
    (listener: () => void) => subscribe(key, listener),
    // The serialized user/workspace pair is the actual cache identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serializedKey],
  );
  const readSnapshot = useCallback(
    () => getSessionRepositorySnapshot(key),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serializedKey],
  );
  const snapshot = useSyncExternalStore(subscribeToKey, readSnapshot, () => EMPTY_SNAPSHOT);

  useEffect(() => {
    void loadSessionRepositories(key).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedKey]);

  return snapshot;
}

export function resetSessionRepositoryCacheForTests() {
  entries.clear();
  activeUserId = null;
  if (invalidationListenerAttached && typeof window !== "undefined") {
    window.removeEventListener(SESSION_REPOSITORIES_CHANGED_EVENT, handleRepositoriesChanged);
  }
  invalidationListenerAttached = false;
}
