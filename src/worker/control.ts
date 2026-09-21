import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname } from "node:path";

export type WorkerControlStatus = {
  workerId: string;
  phase: "running" | "draining" | "drained" | "stopping";
  activeJobIds: string[];
};

type WorkerControls = {
  getStatus: () => WorkerControlStatus;
  requestDrain: () => void;
};

/** Local operator control only: private directory, owner-only socket, no TCP listener. */
export async function startWorkerControlServer(socketPath: string, controls: WorkerControls) {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    throw new Error("Worker control socket requires an owner-only directory (mode 0700)");
  }
  await removeStaleSocket(socketPath);

  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "close");
    if (request.method === "POST" && request.url === "/drain") {
      controls.requestDrain();
      response.writeHead(202).end(JSON.stringify(controls.getStatus()));
    } else if (request.method === "GET" && request.url === "/status") {
      response.end(JSON.stringify(controls.getStatus()));
    } else {
      response.writeHead(404).end(JSON.stringify({ error: "Unknown worker control command" }));
    }
  });
  server.setTimeout(5_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.()) {
    throw new Error("Refusing to replace a non-socket or another user's worker control path");
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Worker control socket is already in use"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
    probe.setTimeout(1_000, () =>
      probe.destroy(new Error("Worker control socket probe timed out")),
    );
  });
  await unlink(socketPath);
}
