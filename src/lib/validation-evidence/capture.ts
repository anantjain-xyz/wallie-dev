import "server-only";

import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

import { RAW_SOURCE_ATTRIBUTES_ASSERTION } from "@/lib/pipeline/source-checkpoint";
import { redactSecrets } from "@/lib/sandbox/command";
import type { SandboxHandle } from "@/lib/sandbox/types";
import {
  type CapturedValidationEvidence,
  type ValidationEvidenceAsset,
  type ValidationEvidenceRecord,
  type ValidationPlan,
} from "./contracts";

const SHA = /^[a-f0-9]{40}$/;
export const MAX_EVIDENCE_LOG_BYTES = 64 * 1024;
export const MAX_EVIDENCE_ASSET_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_TOTAL_BYTES = 4 * 1024 * 1024;

/** A bounded, fixed-format probe: raw provider output is never persisted. */
const PROBE = String.raw`
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
${RAW_SOURCE_ATTRIBUTES_ASSERTION}
const gitConfig = ['-c','core.fsmonitor=false','-c','core.ignoreStat=false','-c','core.trustctime=true','-c','core.checkStat=default','-c','core.untrackedCache=false','-c','core.autocrlf=false','-c','core.eol=lf'];
function git(args) {
  const result = spawnSync('git', [...gitConfig,...args], { encoding:'utf8', maxBuffer:65536 });
  if (result.error || result.status !== 0) throw new Error('Git probe failed');
  return result.stdout.trim();
}
try {
  assertRawSourceAttributes(gitConfig);
  const commitSha = git(['rev-parse','--verify','HEAD^{commit}']);
  const treeSha = git(['rev-parse','--verify','HEAD^{tree}']);
  const tracked = spawnSync('git',[...gitConfig,'ls-files','-v','-z'],{encoding:'utf8',maxBuffer:4194304});
  if(tracked.error || tracked.status !== 0) throw new Error('Index probe failed');
  const hidden = tracked.stdout.split('\0').some(record => record && (/^[a-z]/.test(record) || record.startsWith('S ')));
  let actualTreeSha = null;
  if(!hidden) {
    // Hash the checkout with a fresh index. A status run under weak repository
    // settings may already have cached an edited file's stat as clean, making
    // even --really-refresh insufficient. Never mutate the agent's real index.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'wallie-validation-index-'));
    try {
      const env = {...process.env,GIT_INDEX_FILE:path.join(directory,'index')};
      for(const args of [['read-tree','HEAD'],['add','--all'],['write-tree']]) {
        const result = spawnSync('git',[...gitConfig,...args],{env,encoding:'utf8',maxBuffer:65536});
        if(result.error || result.status !== 0) throw new Error('Validation tree unavailable');
        if(args[0] === 'write-tree') actualTreeSha = result.stdout.trim();
      }
    } finally { fs.rmSync(directory,{recursive:true,force:true}); }
  }
  const clean = !hidden && actualTreeSha === treeSha && git(['status','--porcelain','--untracked-files=normal','--ignore-submodules=none']) === '';
  process.stdout.write(JSON.stringify({commitSha,treeSha,clean}));
} catch { process.exitCode=1; }
`;

/**
 * Commands receive a fresh report directory. Neither old sandbox reports nor
 * agent-produced event JSON can impersonate these execution receipts. The
 * wrapper caps all output before it crosses the provider API and rejects
 * symlinked paths and binary assets before reading report bytes.
 */
const RUN_COMMAND = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const command = JSON.parse(process.argv[1]);
const directory = fs.mkdtempSync('/tmp/wallie-validation-');
fs.chmodSync(directory,0o700);
let log = Buffer.alloc(0);
let truncated = false;
let timedOut = false;
let timer;
const child = spawn('bash',['--noprofile','--norc','-c',command.command],{
  env:{...process.env,WALLIE_EVIDENCE_DIR:directory}, detached:true, stdio:['ignore','pipe','pipe']
});
const append = (chunk) => {
  const remaining = 65536 - log.length;
  if(chunk.length > remaining) truncated=true;
  if(remaining > 0) log=Buffer.concat([log,chunk.subarray(0,remaining)]);
};
child.stdout.on('data',append); child.stderr.on('data',append);
const kill = () => { try { process.kill(-child.pid,'SIGKILL'); } catch {} };
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>{
  kill(); fs.rmSync(directory,{recursive:true,force:true}); process.exit(1);
});
// 'close' waits for inherited pipes, including pipes held by a descendant
// that started another process group. Settle the receipt at the deadline
// independently of that event, then release our readers and process handle.
timer=setTimeout(()=>{timedOut=true;finish(null,true);},command.timeoutSeconds*1000);
function report(spec) {
  if(spec.kind === 'screenshot') return null;
  try {
    const parts=spec.path.split('/');
    if(parts.some(part => !part || part==='.' || part==='..') || path.isAbsolute(spec.path)) return null;
    let current=directory;
    for (const part of parts) {
      current=path.join(current,part);
      if(fs.lstatSync(current).isSymbolicLink()) return null;
    }
    const stat=fs.statSync(current);
    if(!stat.isFile() || stat.size > 1048576) return null;
    const fd=fs.openSync(current,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
      const buffer=Buffer.alloc(stat.size+1);
      const count=fs.readSync(fd,buffer,0,buffer.length,0);
      if(count>1048576 || count!==stat.size) return null;
      const bytes=buffer.subarray(0,count);
      if(bytes.includes(0)) return null;
      new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      return bytes.toString('base64');
    } finally { fs.closeSync(fd); }
  } catch {return null;}
}
let settled=false;
function finish(code,error) {
  if(settled)return;settled=true;clearTimeout(timer);kill();
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  try {
    const reports=command.reports.map(spec=>({key:spec.key,bytes:timedOut ? null : report(spec)}));
    // Cancellation may cut a credential in the middle. The collector discards
    // truncated logs, so treat timeout output as truncated as well.
    process.stdout.write(JSON.stringify({exitCode:code,error:!!error||timedOut,truncated:truncated||timedOut,log:timedOut ? '' : log.toString('base64'),reports}));
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
child.once('error',()=>finish(null,true));
child.once('close',(code)=>finish(code,false));
`;

type Identity = { commitSha: string; treeSha: string; clean: boolean };

async function boundedNode(
  sandbox: SandboxHandle,
  script: string,
  args: string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const process = await sandbox.exec("node", ["-e", script, ...args], {
    cwd: sandbox.repoPath,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
    signal,
  });
  const [output, code] = await Promise.all([process.output(), process.exitCode]);
  signal?.throwIfAborted();
  if (code !== 0) throw new Error("Validation evidence collection failed.");
  return output.stdout;
}

export async function readValidationIdentity(
  sandbox: SandboxHandle,
  signal?: AbortSignal,
): Promise<Identity> {
  const value = JSON.parse(await boundedNode(sandbox, PROBE, [], signal)) as Identity;
  if (!SHA.test(value.commitSha) || !SHA.test(value.treeSha) || typeof value.clean !== "boolean") {
    throw new Error("Validation source identity is unavailable.");
  }
  return value;
}

function redactCredentialValues(value: string, secrets: readonly string[]): string {
  return redactSecrets(value, [...secrets])
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g,
      "[REDACTED]",
    );
}

export function redactValidationText(value: string, secrets: readonly string[] = []): string {
  return redactCredentialValues(value, secrets).replace(
    /(\b(?:authorization\s*:\s*(?:bearer\s+)?|[\w-]*(?:token|secret|password|api[_-]?key|credential)[\w-]*["']?\s*[:=]\s*))["']?[^\r\n,;]+/gi,
    "$1[REDACTED]",
  );
}

const ENV_REFERENCE = String.raw`\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})`;
const CREDENTIAL_REFERENCE_ASSIGNMENT = new RegExp(
  String.raw`\b[\w-]*(?:token|secret|password|api[_-]?key|credential)[\w-]*\s*=\s*(?:"${ENV_REFERENCE}"|'${ENV_REFERENCE}'|${ENV_REFERENCE})(?=$|[\s;&|()<>])`,
  "gi",
);
const AUTHORIZATION_REFERENCE = new RegExp(
  String.raw`(["'])authorization\s*:\s*(?:bearer\s+)?${ENV_REFERENCE}\1(?=$|[\s;&|()<>])`,
  "gi",
);

/** Only literal variable references are exempt; output always uses full redaction. */
export function redactValidationCommand(value: string, secrets: readonly string[] = []): string {
  if (redactCredentialValues(value, secrets) !== value) return redactValidationText(value, secrets);
  const literals = value
    .replace(CREDENTIAL_REFERENCE_ASSIGNMENT, "")
    .replace(AUTHORIZATION_REFERENCE, "");
  return redactValidationText(literals, secrets) === literals
    ? value
    : redactValidationText(value, secrets);
}

function safeText(bytes: Buffer, secrets: readonly string[]): Buffer | null {
  try {
    if (bytes.includes(0)) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Buffer.from(redactValidationText(text, secrets));
  } catch {
    return null;
  }
}

/** Independently execute configured validation after the agent has stopped. */
export async function captureValidationEvidence(input: {
  sandbox: SandboxHandle;
  commitSha: string;
  plan: ValidationPlan;
  secrets?: readonly string[];
  signal?: AbortSignal;
}): Promise<CapturedValidationEvidence> {
  const { sandbox, signal } = input;
  const secrets = input.secrets ?? [];
  if (!SHA.test(input.commitSha)) throw new Error("Invalid validation checkpoint.");
  const initial = await readValidationIdentity(sandbox, signal);
  if (initial.commitSha !== input.commitSha || !initial.clean) {
    throw new Error("Validation checkpoint changed before execution.");
  }
  const result: CapturedValidationEvidence = {
    commitSha: input.commitSha,
    treeSha: initial.treeSha,
    records: [],
    assets: [],
  };
  const identities = JSON.stringify(
    input.plan.commands.map((command) => ({
      key: command.key,
      reports: command.reports.map((report) => report.key),
    })),
  );
  if (redactValidationText(identities, secrets) !== identities) {
    throw new Error("Validation identities contain sensitive material.");
  }
  let totalBytes = 0;
  const addAsset = (asset: Omit<ValidationEvidenceAsset, "id">): boolean => {
    if (
      asset.bytes.length > MAX_EVIDENCE_ASSET_BYTES ||
      totalBytes + asset.bytes.length > MAX_EVIDENCE_TOTAL_BYTES
    )
      return false;
    totalBytes += asset.bytes.length;
    result.assets.push({ ...asset, id: randomUUID() });
    return true;
  };
  for (const command of input.plan.commands) {
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const record: ValidationEvidenceRecord = {
      key: command.key,
      command: redactValidationCommand(command.command, secrets).slice(0, 4096),
      provenance: "harness",
      status: "error",
      exitCode: null,
      startedAt,
      completedAt: startedAt,
      commitSha: null,
      treeSha: null,
      finalCommitSha: null,
      finalTreeSha: null,
      reportKeys: command.reports
        .filter((report) => report.required)
        .map((report) => `${command.key}/${report.key}`),
      missingRequiredReports: [],
    };
    result.records.push(record);
    try {
      const before = await readValidationIdentity(sandbox, signal);
      record.commitSha = before.commitSha;
      record.treeSha = before.treeSha;
      if (
        !before.clean ||
        before.commitSha !== input.commitSha ||
        before.treeSha !== initial.treeSha
      ) {
        record.status = "stale";
        break;
      }
      const raw = JSON.parse(
        await boundedNode(sandbox, RUN_COMMAND, [JSON.stringify(command)], signal),
      ) as {
        exitCode: number | null;
        error: boolean;
        truncated: boolean;
        log: string;
        reports: Array<{ key: string; bytes: string | null }>;
      };
      record.exitCode = Number.isSafeInteger(raw.exitCode) ? raw.exitCode : null;
      // A truncation boundary could split a secret. Discard the entire log
      // rather than persist a credential prefix that cannot be recognized.
      const log = raw.truncated ? null : safeText(Buffer.from(raw.log, "base64"), secrets);
      if (log)
        addAsset({
          key: `${command.key}/log`,
          kind: "log",
          required: false,
          bytes: log,
          contentType: "text/plain",
        });
      for (const report of command.reports) {
        const bytes = raw.reports.find((candidate) => candidate.key === report.key)?.bytes;
        const text =
          bytes === null || bytes === undefined
            ? null
            : safeText(Buffer.from(bytes, "base64"), secrets);
        const accepted =
          text !== null &&
          addAsset({
            key: `${command.key}/${report.key}`,
            kind: report.kind,
            required: report.required,
            bytes: text,
            contentType: "text/plain",
          });
        if (!accepted && report.required)
          record.missingRequiredReports.push(`${command.key}/${report.key}`);
      }
      const after = await readValidationIdentity(sandbox, signal);
      record.finalCommitSha = after.commitSha;
      record.finalTreeSha = after.treeSha;
      record.status =
        !after.clean || after.commitSha !== input.commitSha || after.treeSha !== initial.treeSha
          ? "stale"
          : raw.error || raw.truncated || record.exitCode === null
            ? "error"
            : record.exitCode !== 0 || record.missingRequiredReports.length
              ? "failed"
              : "passed";
    } catch {
      signal?.throwIfAborted();
      record.status = "error";
    } finally {
      record.completedAt = new Date().toISOString();
    }
  }
  // A later command may mutate files after an earlier command passed. Keep all
  // those receipts for diagnosis, but never leave the earlier receipt passing.
  let final: Identity | null = null;
  try {
    final = await readValidationIdentity(sandbox, signal);
  } catch {
    signal?.throwIfAborted();
  }
  if (
    !final ||
    !final.clean ||
    final.commitSha !== input.commitSha ||
    final.treeSha !== initial.treeSha
  ) {
    for (const record of result.records) {
      record.status = "stale";
      record.finalCommitSha = final?.commitSha ?? null;
      record.finalTreeSha = final?.treeSha ?? null;
    }
  }
  return result;
}
