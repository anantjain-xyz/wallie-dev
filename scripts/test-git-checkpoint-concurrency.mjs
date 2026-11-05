import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const databaseUrl = process.argv[2];
if (!databaseUrl)
  throw new Error("Usage: node scripts/test-git-checkpoint-concurrency.mjs <local-db-url>");
const url = new URL(databaseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  throw new Error("Concurrency fixtures require a local test database.");
}
const sql = (query) =>
  execFileSync(
    "psql",
    [
      databaseUrl,
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `set request.jwt.claim.role='service_role'; ${query}`,
    ],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  ).trim();
const workspace = "b1b2c3d4-0001-4000-8000-000000000001";
const member = "c1b2c3d4-0001-4000-8000-000000000001";
const sha = "a".repeat(40);
const fixtures = [];
const releaseState = () =>
  JSON.parse(sql("select row_to_json(state) from public.get_git_continuity_release_state() state"));
const initialRelease = releaseState();
if (!initialRelease.enabled) {
  sql(
    `select public.set_git_continuity_release(true,${initialRelease.revision},'Isolated loopback ownership concurrency fixture')`,
  );
}

function session() {
  const row = JSON.parse(
    sql(
      `select row_to_json(f) from public.create_session_with_first_job('${workspace}','${member}','Git concurrency ${randomUUID()}','Fixed input','codex','gpt-5.5',null,null,null,null) f`,
    ),
  );
  fixtures.push(row.session_id);
  sql(
    `update public.agent_jobs set status='running',attempt_count=1,git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()) where id='${row.job_id}'; select public.start_session_job_attempt('${row.job_id}',1,current_stage_id,0,'codex','gpt-5.5','project','wallie/concurrency-${row.job_id}') from public.sessions where id='${row.session_id}'`,
  );
  return row;
}
function pin(row) {
  return `select count(*) from public.pin_session_job_git_input('${row.job_id}',1,'${row.run_id}',(select id from public.github_repositories where workspace_id='${workspace}' order by id limit 1),'main','${sha}')`;
}
function processSql() {
  const child = spawn("psql", [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const listeners = new Set();
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (const notify of listeners) notify();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error(`psql exited ${code}: ${errors}`)),
    );
  });
  return {
    child,
    done,
    wait: (marker) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(notify);
          reject(new Error(`Timed out waiting for ${marker}`));
        }, 10_000);
        const notify = () => {
          if (output.includes(marker)) {
            clearTimeout(timeout);
            listeners.delete(notify);
            resolve();
          }
        };
        listeners.add(notify);
        notify();
      }),
  };
}
async function raceAfterSessionLock(row, query) {
  const owner = processSql();
  const contender = processSql();
  try {
    owner.child.stdin.write(
      `begin; select id from public.sessions where id='${row.session_id}' for no key update;\n\\echo LOCK_READY\n`,
    );
    await owner.wait("LOCK_READY");
    contender.child.stdin.end(
      `set application_name='op494-contender-${row.job_id}'; set statement_timeout='10s'; ${query};\n`,
    );
    // Observe a real blocked database connection, rather than assuming a delay
    // means the contender reached the ownership boundary.
    const deadline = Date.now() + 10_000;
    while (
      sql(
        `select count(*) from pg_stat_activity where application_name='op494-contender-${row.job_id}' and wait_event_type='Lock'`,
      ) !== "1"
    ) {
      if (Date.now() >= deadline) throw new Error("Contender did not wait on the session lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    owner.child.stdin.end(
      `update public.agent_jobs set attempt_count=2 where id='${row.job_id}'; update public.agent_runs set status='error' where id='${row.run_id}'; commit;\n`,
    );
    await owner.done;
    return await contender.done;
  } finally {
    owner.child.kill();
    contender.child.kill();
  }
}

try {
  const stalePin = session();
  assert.equal(await raceAfterSessionLock(stalePin, pin(stalePin)), "0");
  assert.equal(
    sql(`select count(*) from public.session_job_git_inputs where job_id='${stalePin.job_id}'`),
    "0",
  );
  console.log("PASS: an attempt replaced while waiting cannot pin code input");

  const stalePublication = session();
  assert.equal(sql(pin(stalePublication)), "1");
  assert.equal(
    sql(
      `select public.prepare_session_source_delivery('${stalePublication.run_id}',(select id from public.github_repositories where workspace_id='${workspace}' order by id limit 1),'main','${sha}','${sha}','No code','Artifact','','','')`,
    ),
    "t",
  );
  assert.equal(
    await raceAfterSessionLock(
      stalePublication,
      `select public.publish_session_job_with_source('${stalePublication.job_id}',1,'${stalePublication.run_id}',0,'Artifact')`,
    ),
    "f",
  );
  assert.equal(
    sql(
      `select count(*) from public.session_git_checkpoints where run_id='${stalePublication.run_id}'`,
    ),
    "0",
  );
  assert.equal(
    sql(
      `select count(*) from public.session_artifacts where session_id='${stalePublication.session_id}'`,
    ),
    "0",
  );
  console.log("PASS: an attempt replaced while waiting cannot adopt a checkpoint or artifact");
} finally {
  for (const id of fixtures) sql(`delete from public.sessions where id='${id}'`);
  if (!initialRelease.enabled) {
    const current = releaseState();
    sql(
      `select public.set_git_continuity_release(false,${current.revision},'Restore pause after isolated ownership concurrency fixture')`,
    );
  }
}
