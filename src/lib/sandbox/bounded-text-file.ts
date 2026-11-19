import "server-only";

import type { SandboxHandle } from "./types";

const READ_FILE = String.raw`
const fs = require('node:fs');
const maxBytes = Number(process.argv[2]);
try {
  const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error();
    const buffer = Buffer.alloc(maxBytes + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > maxBytes || count !== stat.size) throw new Error();
    const text = new (require('node:util').TextDecoder)('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
    process.stdout.write(text);
  } finally { fs.closeSync(fd); }
} catch { process.exitCode = 1; }
`;

export async function readSandboxBoundedTextFile(input: {
  sandbox: SandboxHandle;
  path: string;
  maxBytes: number;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  const process = await input.sandbox.exec(
    "node",
    ["-e", READ_FILE, input.path, String(input.maxBytes)],
    { signal: input.signal },
  );
  const [output, code] = await Promise.all([process.output(), process.exitCode]);
  input.signal?.throwIfAborted();
  return code === 0 && Buffer.byteLength(output.stdout) <= input.maxBytes ? output.stdout : null;
}
