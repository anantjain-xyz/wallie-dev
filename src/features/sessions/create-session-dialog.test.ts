import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  getLinearUrlError,
  isCreateSessionSubmitDisabled,
  isSessionSubmitShortcut,
  RepositoryField,
} from "./create-session-dialog";

describe("isSessionSubmitShortcut", () => {
  it("matches Command+Enter", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: false, key: "Enter", metaKey: true })).toBe(true);
  });

  it("matches Ctrl+Enter", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: true, key: "Enter", metaKey: false })).toBe(true);
  });

  it("ignores Enter without a shortcut modifier", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: false, key: "Enter", metaKey: false })).toBe(false);
  });

  it("ignores other Command shortcuts", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: false, key: "k", metaKey: true })).toBe(false);
  });

  it("ignores other Ctrl shortcuts", () => {
    expect(isSessionSubmitShortcut({ ctrlKey: true, key: "k", metaKey: false })).toBe(false);
  });
});

describe("getLinearUrlError", () => {
  it("accepts empty and Linear URLs", () => {
    expect(getLinearUrlError("  ")).toBeNull();
    expect(getLinearUrlError("https://linear.app/acme/issue/TEAM-42/title")).toBeNull();
    expect(getLinearUrlError("https://custom.linear.app/acme/issue/TEAM-42/title")).toBeNull();
  });

  it("rejects non-Linear URLs", () => {
    expect(getLinearUrlError("https://example.com/acme/issue/TEAM-42")).toBe(
      "Must be a linear.app URL.",
    );
  });
});

describe("isCreateSessionSubmitDisabled", () => {
  it("waits for repository resolution, including the confirmed empty result", () => {
    expect(
      isCreateSessionSubmitDisabled({
        hasRepositoryResult: false,
        isSubmitting: false,
        prompt: "Build the dashboard",
      }),
    ).toBe(true);
    expect(
      isCreateSessionSubmitDisabled({
        hasRepositoryResult: true,
        isSubmitting: false,
        prompt: "Build the dashboard",
      }),
    ).toBe(false);
  });
});

describe("RepositoryField", () => {
  const cacheKey = { userId: "user-1", workspaceId: "workspace-1" };
  const baseProps = {
    cacheKey,
    onValueChange: () => undefined,
    options: [],
    selectedGithubRepositoryId: "",
  };

  it("announces repository loading", () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryField, {
        ...baseProps,
        snapshot: {
          data: null,
          error: null,
          isLoading: true,
          isRefreshing: false,
          isStale: false,
        },
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading repositories…");
  });

  it("renders an accessible error with a retry button", () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryField, {
        ...baseProps,
        snapshot: {
          data: null,
          error: "Repositories unavailable.",
          isLoading: false,
          isRefreshing: false,
          isStale: false,
        },
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Repositories unavailable.");
    expect(html).toContain(">Retry repositories</button>");
  });

  it("makes the confirmed empty state explicit", () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryField, {
        ...baseProps,
        snapshot: {
          data: { defaultGithubRepositoryId: null, repositoryOptions: [] },
          error: null,
          isLoading: false,
          isRefreshing: false,
          isStale: false,
        },
      }),
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("No repositories are available");
  });

  it("keeps stale options visible with an announced refresh state", () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryField, {
        ...baseProps,
        options: [{ label: "acme/app", value: "repo-1" }],
        selectedGithubRepositoryId: "repo-1",
        snapshot: {
          data: {
            defaultGithubRepositoryId: "repo-1",
            repositoryOptions: [{ fullName: "acme/app", id: "repo-1" }],
          },
          error: null,
          isLoading: false,
          isRefreshing: true,
          isStale: true,
        },
      }),
    );

    expect(html).toContain("acme/app");
    expect(html).toContain('role="status"');
    expect(html).toContain("Refreshing repository options…");
  });

  it("announces a stale-cache error and offers keyboard-accessible refresh", () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryField, {
        ...baseProps,
        options: [{ label: "acme/app", value: "repo-1" }],
        selectedGithubRepositoryId: "repo-1",
        snapshot: {
          data: {
            defaultGithubRepositoryId: "repo-1",
            repositoryOptions: [{ fullName: "acme/app", id: "repo-1" }],
          },
          error: "Network unavailable.",
          isLoading: false,
          isRefreshing: false,
          isStale: true,
        },
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Repository options may be out of date. Network unavailable.");
    expect(html).toContain(">Refresh repositories</button>");
  });
});
