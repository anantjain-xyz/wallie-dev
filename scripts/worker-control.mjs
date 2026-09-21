import { request } from "node:http";
import { isAbsolute } from "node:path";
import { setTimeout } from "node:timers/promises";

async function main() {
  const [command, flag, value, ...extra] = process.argv.slice(2);
  const timeoutSeconds = value === undefined ? 2700 : Number(value);
  if (
    !["status", "drain"].includes(command) ||
    (flag !== undefined &&
      (command !== "drain" || flag !== "--timeout-seconds" || value === undefined)) ||
    extra.length ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1
  ) {
    throw new Error(
      "Usage: node scripts/worker-control.mjs status | drain [--timeout-seconds 2700]",
    );
  }
  const socketPath = process.env.WORKER_CONTROL_SOCKET;
  if (!socketPath || !isAbsolute(socketPath)) {
    throw new Error("Set WORKER_CONTROL_SOCKET to this worker's absolute Unix socket path");
  }
  const deadline = Date.now() + timeoutSeconds * 1000;
  const read = (path, method = "GET") =>
    readStatus(socketPath, path, method, Math.max(1, Math.min(5000, deadline - Date.now())));
  let status = await read(
    command === "drain" ? "/drain" : "/status",
    command === "drain" ? "POST" : "GET",
  );
  const workerId = status.workerId;
  if (command === "drain") {
    while (status.phase !== "drained") {
      if (status.phase === "stopping")
        throw new Error("Worker is already stopping; drain was not confirmed");
      if (Date.now() >= deadline)
        throw new Error("Drain timed out; worker remains draining. Do not stop it yet");
      await setTimeout(Math.min(1000, deadline - Date.now()));
      status = await read("/status");
      if (status.workerId !== workerId)
        throw new Error("Worker identity changed while waiting for drain");
    }
  }
  console.log(JSON.stringify(status));
}

function readStatus(socketPath, path, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, path, method, signal: AbortSignal.timeout(timeoutMs) },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 65536) req.destroy(new Error("Worker status response is too large"));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            if (response.statusCode !== 200 && response.statusCode !== 202) {
              throw new Error(`Worker control returned HTTP ${response.statusCode}`);
            }
            const status = JSON.parse(body);
            if (
              typeof status.workerId !== "string" ||
              !status.workerId ||
              !["running", "draining", "drained", "stopping"].includes(status.phase) ||
              !Array.isArray(status.activeJobIds) ||
              status.activeJobIds.some((id) => typeof id !== "string") ||
              (status.phase === "drained" && status.activeJobIds.length !== 0)
            )
              throw new Error("Invalid worker control status");
            resolve(status);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

main().catch((error) => {
  console.error(`[worker-control] ${error.message}`);
  process.exitCode = 1;
});
