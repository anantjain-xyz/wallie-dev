import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { runtimeCases } from "./runtime-cases.mjs";
import { sampleRoute, summarize } from "./runtime-http.mjs";

let origin;
const server = createServer((req, res) => {
  if (req.url?.startsWith("/board/")) {
    const legacy = req.url === "/board/legacy";
    const current = req.url === "/board/list-selected" ? "List" : "Board";
    const cards = Array.from({ length: 100 }, (_, index) => {
      const n = index + 1 + Math.floor(index / 9);
      const title = n === 1 ? "[wall-audit] Checkout latency short" : `Fixture ${n}`;
      const action = n === 1 && !legacy ? "Review" : "Open";
      return `<a href="/w/acme-corp/sessions/${1000 + n}" aria-label="${action} session ${title}"></a>`;
    }).join("");
    const header = legacy
      ? "<h1>Pipeline</h1>"
      : `<h1>Sessions</h1><nav aria-label="Sessions views"><span aria-current="page">${current}</span></nav>`;
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        header +
          `<div aria-label="Pipeline board">${req.url === "/board/loading" ? "" : cards}</div>`,
      );
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(307, { location: "/ready" }).end();
    return;
  }
  if (req.url === "/flight-error") {
    res
      .writeHead(200, { "content-type": "text/x-component" })
      .end('0:"Ready list"\n1:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}\n');
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.write("<h1>✓ Sessions</h1>");
  if (req.url === "/html-flight-error") {
    const first = JSON.stringify([1, '0:"Ready list"\n1:E{"di']);
    const rest = JSON.stringify([3, Buffer.from('gest":"123"}\n').toString("base64")]);
    res.end(
      `<p>Ready list</p><script nonce="fixture">self.__next_f.push(${first})</script><script>self.__next_f.push(${rest})</script>`,
    );
    return;
  }
  res.end(req.url === "/ready" ? "<p>Ready list</p>" : "<p>Login</p>");
});

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = new URL(`http://127.0.0.1:${server.address().port}`);
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const route = {
  path: "/ready",
  type: "text/html",
  maxBytes: 64,
  markers: [/<h1>✓ Sessions<\/h1>/, "Ready list"],
};
const sample = (changes = {}) => sampleRoute(origin, { ...route, ...changes }, { cookie: "" });

test("reports a route-ready marker only for a valid body", async () => {
  const result = await sample();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 200);
  assert.equal(result.bytes, Buffer.byteLength("<h1>✓ Sessions</h1><p>Ready list</p>"));
  assert.ok(result.headersMs <= result.readyMs && result.readyMs <= result.fullMs);
  assert.equal((await sample({ path: "/login" })).error, "missing_marker");
  assert.equal((await sample({ verify: () => null })).error, "content_or_rows");
});

test("rejects a redirect without following it and a streamed error despite its marker", async () => {
  const result = await sample({ path: "/redirect" });
  assert.equal(result.status, 307);
  assert.equal(result.error, "status");
  assert.equal(
    (await sample({ path: "/flight-error", type: "text/x-component" })).error,
    "stream_error",
  );
});

test("rejects an HTML response whose inline Flight chunks carry a generic error", async () => {
  const result = await sample({ path: "/html-flight-error", maxBytes: 512 });
  assert.equal(result.status, 200);
  assert.equal(result.error, "stream_error");
  assert.equal(result.readyMs, undefined);
});

test("rejects a response larger than the capped body before reporting readiness", async () => {
  const result = await sample({ maxBytes: 25 });
  assert.equal(result.error, "body_budget");
  assert.ok(result.bytes > 25);
  assert.equal(result.readyMs, undefined);
});

test("qualifies a Sessions heading with the selected Board and a populated fixture", async () => {
  const board = runtimeCases(160).find(({ name }) => name === "pipeline-document");
  for (const path of ["/board/legacy", "/board/selected"]) {
    assert.deepEqual((await sampleRoute(origin, { ...board, path }, { cookie: "" })).work, {
      rows: 100,
    });
  }
  for (const path of ["/board/list-selected", "/board/loading"]) {
    assert.equal(
      (await sampleRoute(origin, { ...board, path }, { cookie: "" })).error,
      "missing_marker",
    );
  }
});

test("excludes failures from medians and ranges and counts them separately", () => {
  const result = summarize([
    { readyMs: 8, fullMs: 12, bytes: 102 },
    { error: "body_budget", bytes: 500 },
    { readyMs: 2, fullMs: 6, bytes: 100 },
  ]);
  assert.deepEqual(result, {
    valid: 2,
    failed: 1,
    readyMs: { min: 2, median: 5, max: 8 },
    fullMs: { min: 6, median: 9, max: 12 },
    bytes: { min: 100, median: 101, max: 102 },
  });
});
