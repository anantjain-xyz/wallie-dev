import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import {
  loadSelectedActivityActor,
  searchActivityActors,
} from "@/features/factory-activity/activity-actors-data";
import type { Database } from "@/lib/supabase/database.types";

const workspaceId = "88458b88-ec52-4e8e-a441-b6e6a9186bd3";
const factory = "d18b4467-122d-4367-8628-f76856b8615e";
const id = "17575802-5051-4835-a916-9f6419560ab6";

it("looks up actor names and search results through scoped memberships or historical records", async () => {
  const calls: URL[] = [];
  const supabase = createClient<Database>("https://activity.example.test", "viewer-fixture", {
    auth: { persistSession: false },
    global: {
      fetch: async (input) => {
        const url = new URL(String(input));
        calls.push(url);
        const selected = url.searchParams.has("id");
        const member = { id, full_name: "Jamie Sample", username: "jamie", kind: "human" };
        return Response.json(
          selected ? [member] : [member, { id: "missing", full_name: " ", kind: "human" }],
        );
      },
    },
  });
  const scope = { supabase, workspaceId, factory };
  expect(await loadSelectedActivityActor(scope, id)).toEqual({
    id,
    label: "Jamie Sample (@jamie)",
  });
  expect(await searchActivityActors(scope, "jamie")).toEqual({
    actors: [{ id, label: "Jamie Sample (@jamie)" }],
    hasMore: false,
  });
  for (const { pathname, searchParams } of calls) {
    expect(pathname).toBe("/rest/v1/workspace_members");
    expect(searchParams.get("workspace_id")).toBe("eq." + workspaceId);
    expect(searchParams.get("seat.factory_id")).toBe("eq." + factory);
    expect(searchParams.get("seat.revoked_at")).toBe("is.null");
    expect(searchParams.get("created.factory_id")).toBe("eq." + factory);
    expect(searchParams.get("triggered.session.factory_id")).toBe("eq." + factory);
    expect(searchParams.getAll("or")).toContain(
      "(seat.not.is.null,created.not.is.null,triggered.not.is.null)",
    );
  }
  expect(calls[0].searchParams.get("id")).toBe("eq." + id);
  expect(calls[1].searchParams.get("limit")).toBe("21");
  expect(calls[1].searchParams.getAll("or")).toContain(
    '(full_name.ilike."%jamie%",username.ilike."%jamie%")',
  );
});
