import { describe, expect, it } from "vitest";

import {
  buildSessionsListHref,
  compareSessionsBySort,
  resolveOptimisticArchive,
  resolveOptimisticTitle,
  shouldApplyArchiveResult,
} from "@/features/sessions/list/sessions-list-mutations";

describe("sessions list helpers", () => {
  it("builds URL-addressable filter hrefs including non-default sort", () => {
    expect(
      buildSessionsListHref("/w/acme/sessions", {
        cursor: "c1",
        query: " auth ",
        scope: "active",
        sort: "updated",
        stageSlug: "build",
      }),
    ).toBe("/w/acme/sessions?stage=build&q=auth&scope=active&cursor=c1");

    expect(
      buildSessionsListHref("/w/acme/sessions", {
        cursor: null,
        query: "",
        scope: "all",
        sort: "oldest",
        stageSlug: null,
      }),
    ).toBe("/w/acme/sessions?sort=oldest");

    expect(
      buildSessionsListHref("/w/acme/sessions", {
        cursor: null,
        query: "",
        scope: "all",
        sort: "updated",
        stageSlug: null,
      }),
    ).toBe("/w/acme/sessions");
  });

  it("orders sessions by the active sort key", () => {
    const older = {
      id: "a",
      number: 1,
      updatedAt: "2026-06-07T10:00:00.000Z",
    };
    const newer = {
      id: "b",
      number: 2,
      updatedAt: "2026-06-07T12:00:00.000Z",
    };

    expect(
      [older, newer].sort((left, right) => compareSessionsBySort(left, right, "updated")),
    ).toEqual([newer, older]);
    expect(
      [older, newer].sort((left, right) => compareSessionsBySort(left, right, "oldest")),
    ).toEqual([older, newer]);
    expect(
      [older, newer].sort((left, right) => compareSessionsBySort(left, right, "number")),
    ).toEqual([newer, older]);
  });

  it("keeps an optimistic title only while keyed to the authoritative snapshot", () => {
    const session = {
      title: "Server title",
      updatedAt: "2026-06-07T11:00:00.000Z",
    };

    expect(
      resolveOptimisticTitle(session, {
        authoritativeTitle: "Server title",
        authoritativeUpdatedAt: "2026-06-07T11:00:00.000Z",
        title: "Optimistic title",
      }),
    ).toBe("Optimistic title");

    expect(
      resolveOptimisticTitle(
        { title: "Newer server title", updatedAt: "2026-06-07T13:00:00.000Z" },
        {
          authoritativeTitle: "Server title",
          authoritativeUpdatedAt: "2026-06-07T11:00:00.000Z",
          title: "Optimistic title",
        },
      ),
    ).toBe("Newer server title");
  });

  it("keeps an optimistic archive only while keyed to the authoritative snapshot", () => {
    const session = {
      archivedAt: "2026-06-07T10:00:00.000Z",
      phaseStatus: "awaiting_review" as const,
      updatedAt: "2026-06-07T11:00:00.000Z",
    };

    expect(
      resolveOptimisticArchive(session, {
        authoritativeArchivedAt: "2026-06-07T10:00:00.000Z",
        authoritativeUpdatedAt: "2026-06-07T11:00:00.000Z",
        archivedAt: null,
        phaseStatus: "awaiting_review",
      }),
    ).toEqual({ archivedAt: null, phaseStatus: "awaiting_review" });

    expect(
      resolveOptimisticArchive(
        {
          archivedAt: "2026-06-07T14:00:00.000Z",
          phaseStatus: "agent_generating",
          updatedAt: "2026-06-07T14:00:00.000Z",
        },
        {
          authoritativeArchivedAt: "2026-06-07T10:00:00.000Z",
          authoritativeUpdatedAt: "2026-06-07T11:00:00.000Z",
          archivedAt: null,
          phaseStatus: "awaiting_review",
        },
      ),
    ).toEqual({
      archivedAt: "2026-06-07T14:00:00.000Z",
      phaseStatus: "agent_generating",
    });
  });

  it("rejects stale archive results after a newer concurrent mutation", () => {
    const archivedAtAtStart = "2026-06-07T10:00:00.000Z";
    const staleUnarchive = { updatedAt: "2026-06-07T12:00:00.000Z" };
    const newerRearchive = {
      archivedAt: "2026-06-07T13:00:00.000Z",
      updatedAt: "2026-06-07T13:00:00.000Z",
    };

    expect(shouldApplyArchiveResult(staleUnarchive, newerRearchive, archivedAtAtStart)).toBe(false);

    expect(
      shouldApplyArchiveResult(
        { updatedAt: "2026-06-07T14:00:00.000Z" },
        {
          archivedAt: archivedAtAtStart,
          updatedAt: "2026-06-07T11:00:00.000Z",
        },
        archivedAtAtStart,
      ),
    ).toBe(true);

    expect(
      shouldApplyArchiveResult(
        { updatedAt: "2026-06-07T11:00:00.000Z" },
        {
          archivedAt: archivedAtAtStart,
          updatedAt: "2026-06-07T11:00:00.000Z",
        },
        archivedAtAtStart,
      ),
    ).toBe(true);
  });
});
