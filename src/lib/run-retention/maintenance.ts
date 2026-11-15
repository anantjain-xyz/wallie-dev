import "server-only";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { VALIDATION_EVIDENCE_BUCKET } from "@/lib/validation-evidence/service";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Expire access first, then independently drain each bounded, durable cleanup queue. */
export async function drainRunRetention(admin: AdminClient) {
  const { data: marked, error: markError } = await admin.rpc("mark_expired_workspace_run_content");
  if (markError) throw markError;

  const { data: transcriptsPurged, error: purgeError } = await admin.rpc(
    "purge_expired_run_transcripts",
  );
  if (purgeError) throw purgeError;

  const { data: claims, error: claimError } = await admin.rpc("claim_run_evidence_purges");
  if (claimError) throw claimError;
  const result = {
    transcriptsExpired: marked?.[0]?.transcripts_expired ?? 0,
    evidenceExpired: marked?.[0]?.evidence_expired ?? 0,
    transcriptsPurged: transcriptsPurged ?? 0,
    evidencePurged: 0,
  };
  if (!claims?.length) return result;

  // A failed remove or lost acknowledgement leaves the claim ready to retry
  // after its lease. Retrying absent paths through Storage is safe.
  const { error: storageError } = await admin.storage
    .from(VALIDATION_EVIDENCE_BUCKET)
    .remove(claims.map(({ storage_path }) => storage_path));
  if (storageError) throw storageError;

  const { data: purged, error: completeError } = await admin.rpc("complete_run_evidence_purges", {
    p_claim_ids: claims.map(({ claim_id }) => claim_id),
  });
  if (completeError) throw completeError;
  return { ...result, evidencePurged: purged ?? 0 };
}
