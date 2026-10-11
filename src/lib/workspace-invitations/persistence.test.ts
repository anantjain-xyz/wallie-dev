import { describe, expect, it } from "vitest";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  saveInvitationForDelivery,
  undoInvitationDelivery,
  type InvitationSnapshot,
} from "./persistence";

const original: InvitationSnapshot = {
  id: "invitation",
  workspace_id: "workspace",
  email: "member@example.com",
  full_name: "Member",
  role: "member",
  status: "pending",
  token_hash: "original",
  invited_by_member_id: "manager",
  accepted_by_member_id: null,
  expires_at: "2026-10-20T00:00:00Z",
  last_sent_at: "2026-10-10T00:00:00Z",
  accepted_at: null,
  revoked_at: null,
  created_at: "2026-10-10T00:00:00Z",
  updated_at: "2026-10-10T00:00:00Z",
};

/** Executes filters at mutation time, allowing actual interleavings between awaits. */
function store(initial: InvitationSnapshot | null = original) {
  let row = initial ? { ...initial } : null;
  const admin = {
    from() {
      let operation: "update" | "insert" | "delete";
      let patch: Partial<InvitationSnapshot> = {};
      const filters: [string, unknown][] = [];
      function execute() {
        if (operation === "insert") {
          if (row?.status === "pending") return { data: null, error: { code: "23505" } };
          row = { ...original, ...patch };
          return { data: { ...row }, error: null };
        }
        if (
          !row ||
          filters.some(([key, value]) => row?.[key as keyof InvitationSnapshot] !== value)
        ) {
          return { data: null, error: null };
        }
        row = operation === "delete" ? null : { ...row, ...patch };
        return { data: row ? { ...row } : null, error: null };
      }
      const query = {
        update(value: Partial<InvitationSnapshot>) {
          operation = "update";
          patch = value;
          return query;
        },
        insert(value: Partial<InvitationSnapshot>) {
          operation = "insert";
          patch = value;
          return query;
        },
        delete() {
          operation = "delete";
          return query;
        },
        eq(key: string, value: unknown) {
          filters.push([key, value]);
          return query;
        },
        select() {
          return query;
        },
        single: async () => execute(),
        maybeSingle: async () => execute(),
        then(resolve: (value: ReturnType<typeof execute>) => unknown) {
          return Promise.resolve(execute()).then(resolve);
        },
      };
      return query;
    },
  } as unknown as ReturnType<typeof createSupabaseAdminClient>;
  return {
    admin,
    read: () => (row ? { ...row } : null),
    transition(status: "accepted" | "revoked") {
      if (row) row = { ...row, status };
    },
  };
}

async function rotate(
  db: ReturnType<typeof store>,
  previous: InvitationSnapshot | null,
  token: string,
) {
  return saveInvitationForDelivery({
    admin: db.admin,
    email: original.email,
    fields: { ...original, token_hash: token, full_name: token },
    previous,
    workspaceId: original.workspace_id,
  });
}

describe("invitation delivery ownership", () => {
  it("allows only one rotation of the same pending snapshot", async () => {
    const db = store();
    const snapshot = db.read();
    const results = await Promise.all([
      rotate(db, snapshot, "first"),
      rotate(db, snapshot, "second"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(db.read()?.token_hash).toBe("first");
  });

  it.each(["accepted", "revoked"] as const)(
    "does not rotate an invitation already %s",
    async (status) => {
      const db = store();
      const snapshot = db.read();
      db.transition(status);
      expect(await rotate(db, snapshot, "late")).toBeNull();
      expect(db.read()).toMatchObject({ status, token_hash: "original" });
    },
  );

  it.each([false, true])(
    "late failed delivery preserves a newer resend (new: %s)",
    async (created) => {
      const db = store(created ? null : original);
      const previous = db.read();
      const first = (await rotate(db, previous, "first"))!;
      const second = (await rotate(db, db.read(), "second"))!;
      await undoInvitationDelivery({ admin: db.admin, previous, saved: first });
      expect(db.read()).toEqual(second);
    },
  );

  it.each(["accepted", "revoked"] as const)(
    "failed delivery preserves an invitation now %s",
    async (status) => {
      const db = store();
      const first = (await rotate(db, db.read(), "first"))!;
      db.transition(status);
      await undoInvitationDelivery({ admin: db.admin, previous: original, saved: first });
      expect(db.read()).toMatchObject({ status, token_hash: "first" });
    },
  );

  it("restores the prior token and metadata when its own delivery fails", async () => {
    const db = store();
    const first = (await rotate(db, db.read(), "first"))!;
    await undoInvitationDelivery({ admin: db.admin, previous: original, saved: first });
    expect(db.read()).toEqual(original);
  });

  it("deletes only its own new pending invitation on failure", async () => {
    const db = store(null);
    const first = (await rotate(db, null, "first"))!;
    await undoInvitationDelivery({ admin: db.admin, previous: null, saved: first });
    expect(db.read()).toBeNull();
  });

  it("returns a conflict when another create won the pending-email constraint", async () => {
    const db = store();
    expect(await rotate(db, null, "duplicate")).toBeNull();
    expect(db.read()).toEqual(original);
  });
});
