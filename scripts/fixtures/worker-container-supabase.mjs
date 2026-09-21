// An empty queue exercises the real worker lifecycle without a database or agents.
import { createServer } from "node:http";

const state = {
  workerId: null,
  heartbeats: 0,
  claims: 0,
  cursorPolls: 0,
  deregistered: false,
  errors: [],
};

createServer(async (request, response) => {
  const url = new URL(request.url, "http://supabase:3001");
  response.setHeader("Content-Type", "application/json");
  const reply = (status, body) => {
    response.writeHead(status);
    response.end(JSON.stringify(body));
  };
  const fail = (message) => {
    state.errors.push(message);
    reply(500, { message });
  };
  if (url.pathname === "/_smoke/state") return reply(200, state);
  if (request.headers.authorization !== "Bearer worker-container-smoke-secret") {
    return fail("Missing synthetic service credential");
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;

  if (url.pathname === "/rest/v1/worker_heartbeats") {
    if (request.method === "POST") {
      if (!body.worker_id || body.active_job_ids?.length !== 0) {
        return fail("Invalid worker registration");
      }
      state.workerId = body.worker_id;
      return reply(201, null);
    }
    if (url.searchParams.get("worker_id") !== `eq.${state.workerId}`) {
      return fail("Worker identity changed");
    }
    if (request.method === "PATCH") {
      if (!body.last_heartbeat_at || body.active_job_ids?.length !== 0) {
        return fail("Invalid idle heartbeat");
      }
      state.heartbeats += 1;
      return reply(204, null);
    }
    if (request.method === "DELETE") {
      state.deregistered = true;
      return reply(204, null);
    }
  }
  if (url.pathname === "/rest/v1/rpc/claim_next_agent_job" && request.method === "POST") {
    if (body.default_concurrency_limit !== 2) return fail("Invalid queue claim");
    state.claims += 1;
    return reply(200, []);
  }
  if (url.pathname === "/rest/v1/cursor_auth_flows") {
    if (request.method === "PATCH") return reply(204, null);
    if (request.method === "GET") {
      state.cursorPolls += 1;
      return reply(200, []);
    }
  }
  fail(`Unexpected request: ${request.method} ${url.pathname}`);
}).listen(3001, "0.0.0.0");
