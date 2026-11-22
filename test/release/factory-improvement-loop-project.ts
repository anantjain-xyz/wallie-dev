import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { z } from "zod/v4";

import {
  improvementQualificationDatabaseEnvironment,
  loopbackQualificationUrl,
  type ImprovementLoopContext,
} from "./factory-improvement-loop-contract";

const exec = promisify(execFile);
const verifiedProjects = new WeakMap<ImprovementLoopContext["admin"], string>();

export async function assertImprovementLoopProject(context: ImprovementLoopContext) {
  const api = loopbackQualificationUrl(context.apiUrl, ["http:"]);
  const env = improvementQualificationDatabaseEnvironment(context.dbUrl);
  const scope = JSON.stringify([api.origin, context.dbUrl]);
  if (verifiedProjects.get(context.admin) === scope) return;

  const nonceColumn = `wallie_project_${randomUUID().replaceAll("-", "")}`;
  const request = new AbortController();
  const transaction = exec("psql", ["-XqAtw", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    env,
    timeout: 8_000,
  });
  try {
    const { stdin, stdout } = transaction.child;
    if (!stdin || !stdout) throw new Error("Could not open the local project probe.");
    const lines = createInterface({ input: stdout });
    const ready = once(lines, "line");
    stdin.on("error", () => transaction.child.kill());
    // The projected alias is part of PostgREST's backend query and correlates this exact request.
    stdin.end(`begin;
set local statement_timeout = '4s';
set local idle_in_transaction_session_timeout = '4s';
lock table internal.git_continuity_release_control in access exclusive mode nowait;
select 'qualification-lock-ready';
do $probe$
begin
  for attempt in 1..50 loop
    perform pg_stat_clear_snapshot();
    if exists (
      select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and strpos(query, '${nonceColumn}') > 0
        and pg_backend_pid() = any(pg_blocking_pids(pid))
    ) then return; end if;
    perform pg_sleep(0.05);
  end loop;
  raise exception 'No matching HTTP read reached the local SQL probe.';
end
$probe$;
rollback;
`);

    const [marker] = await Promise.race([
      ready,
      transaction.then(() => {
        throw new Error("The local SQL probe closed before synchronizing.");
      }),
    ]);
    if (marker !== "qualification-lock-ready") throw new Error("Unexpected SQL probe output.");

    const [result] = await Promise.all([
      context.admin
        .rpc("get_git_continuity_release_state")
        .select(`${nonceColumn}:revision`)
        .abortSignal(AbortSignal.any([request.signal, AbortSignal.timeout(6_000)])),
      transaction,
    ]);
    const projection = z.array(z.object({ [nonceColumn]: z.number().int().positive() })).length(1);
    if (result.error || !projection.safeParse(result.data).success) {
      throw new Error("The authenticated project probe did not return the expected projection.");
    }
    verifiedProjects.set(context.admin, scope);
  } catch (error) {
    throw new Error(
      "Could not verify that Supabase HTTP and SQL share the same disposable project.",
      {
        cause: error,
      },
    );
  } finally {
    request.abort();
    if (transaction.child.exitCode === null) transaction.child.kill();
    await transaction.catch(() => undefined);
  }
}
