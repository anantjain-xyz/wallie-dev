import { describe, expect, it } from "vitest";

import {
  buildSessionsListHref,
  resolveOptimisticTitle,
} from "@/features/sessions/list/sessions-list-mutations";

describe("sessions list helpers", () => {
  it("builds URL-addressable filter hrefs", () => {
    expect(
      buildSessionsListHref("/w/acme/sessions", {
        cursor: "c1",
        query: " auth ",
        scope: "active",
        stageSlug: "build",
      }),
    ).toBe("/w/acme/sessions?stage=build&q=auth&scope=active&cursor=c1");

    expect(
      buildSessionsListHref("/w/acme/sessions", {
        cursor: null,
        query: "",
        scope: "all",
        stageSlug: null,
      }),
    ).toBe("/w/acme/sessions");
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
});
