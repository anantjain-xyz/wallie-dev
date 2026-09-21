// Synthetic Auth/Storage endpoints; both installations stay on isolated loopback.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const png = readFileSync("public/icon-192.png");
for (const port of [3001, 3002]) {
  const state = { calls: [], errors: [], slowStarted: false, slowCompleted: false };
  let releaseSlow;
  createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const reply = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/_smoke/state") return reply(200, state);
    if (url.pathname === "/_smoke/release" && request.method === "POST" && releaseSlow) {
      releaseSlow();
      return reply(200, {});
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    state.calls.push({
      method: request.method,
      url: request.url,
      apikey: request.headers.apikey,
      body: Buffer.concat(chunks).toString(),
    });
    if (url.pathname === "/auth/v1/otp") return reply(200, {});
    if (url.pathname === "/auth/v1/user") {
      return reply(200, {
        id: "00000000-0000-4000-8000-000000000001",
        aud: "authenticated",
        role: "authenticated",
        email: "container-smoke@example.invalid",
        app_metadata: {},
        user_metadata: {},
      });
    }
    if (/^\/storage\/v1\/object\/public\/(workspace|profile)-avatars\//.test(url.pathname)) {
      if (url.pathname.endsWith("/slow.png")) {
        state.slowStarted = true;
        await new Promise((resolve) => {
          releaseSlow = resolve;
        });
        state.slowCompleted = true;
      }
      response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=60" });
      return response.end(png);
    }
    state.errors.push(`Unexpected request: ${request.method} ${request.url}`);
    reply(404, { message: state.errors.at(-1) });
  }).listen(port, "127.0.0.1");
}
