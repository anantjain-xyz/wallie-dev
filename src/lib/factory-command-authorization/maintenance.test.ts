import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { pruneFactoryCommandAdmissions } from "./maintenance";

function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const admin = createClient<Database>("https://supabase.example.test", "fixture", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
  return { admin, fetch };
}

it("continues while either table fills a batch and stops after a partial batch", async () => {
  const { admin, fetch } = fixture();
  fetch
    .mockResolvedValueOnce(Response.json({ admissions_deleted: 500, leases_deleted: 0 }))
    .mockResolvedValueOnce(Response.json({ admissions_deleted: 0, leases_deleted: 500 }))
    .mockResolvedValueOnce(Response.json({ admissions_deleted: 17, leases_deleted: 3 }));

  await expect(pruneFactoryCommandAdmissions(admin)).resolves.toEqual({
    admissionsDeleted: 517,
    leasesDeleted: 503,
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(fetch).toHaveBeenLastCalledWith(
    "https://supabase.example.test/rest/v1/rpc/prune_factory_command_admissions",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ p_batch_size: 500 }) }),
  );
});

it("bounds the number of cleanup batches per worker cycle", async () => {
  const { admin, fetch } = fixture();
  fetch.mockImplementation(async () =>
    Response.json({ admissions_deleted: 500, leases_deleted: 0 }),
  );

  await expect(pruneFactoryCommandAdmissions(admin)).resolves.toEqual({
    admissionsDeleted: 4000,
    leasesDeleted: 0,
  });
  expect(fetch).toHaveBeenCalledTimes(8);
});

it("reports a failed cleanup without exposing the database diagnostic", async () => {
  const { admin, fetch } = fixture();
  fetch.mockResolvedValueOnce(
    Response.json({ message: "Private failure diagnostic" }, { status: 500 }),
  );
  await expect(pruneFactoryCommandAdmissions(admin)).rejects.toThrow(
    "Could not prune expired factory command admissions.",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
