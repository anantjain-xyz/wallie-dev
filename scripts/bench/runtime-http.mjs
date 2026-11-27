import { request as httpRequest } from "node:http";

export async function request(url, { agent, headers, method = "GET", body, maxBytes }) {
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("Expected a loopback HTTP endpoint.");
  }
  const started = performance.now();
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { agent, headers, method, signal: AbortSignal.timeout(20_000) },
      resolve,
    );
    req.once("error", reject);
    req.end(body);
  });
  const result = {
    status: response.statusCode,
    headers: response.headers,
    headersMs: performance.now() - started,
    chunks: [],
    bytes: 0,
    body: null,
    fullMs: null,
  };
  const buffers = [];
  for await (const chunk of response) {
    result.bytes += chunk.length;
    if (result.bytes > maxBytes) return result;
    result.chunks.push({ end: result.bytes, ms: performance.now() - started });
    buffers.push(chunk);
  }
  result.fullMs = performance.now() - started;
  result.body = Buffer.concat(buffers).toString("utf8");
  return result;
}

function markerEnd(body, marker) {
  if (typeof marker === "string") {
    const index = body.indexOf(marker);
    return index >= 0 ? index + marker.length : 0;
  }
  const match = marker.exec(body);
  return match ? match.index + match[0].length : 0;
}

export async function sampleRoute(origin, route, { agent, cookie }) {
  let response;
  try {
    response = await request(new URL(route.path, origin), {
      agent,
      headers: {
        accept: route.type,
        "accept-encoding": "identity",
        cookie,
        ...(route.type === "text/x-component" ? { RSC: "1" } : {}),
      },
      maxBytes: route.maxBytes,
    });
  } catch {
    return { error: "transport", status: null };
  }
  const { status, headers, headersMs, fullMs, bytes, body, chunks } = response;
  const sample = { status, headersMs, fullMs, bytes };
  const failed = (error) => ({ ...sample, error });
  if (status !== 200) return failed("status");
  if (headers["content-type"]?.split(";")[0] !== route.type) return failed("content_type");
  if (headers["content-encoding"] && headers["content-encoding"] !== "identity")
    return failed("content_encoding");
  if (body === null) return failed("body_budget");

  if (route.type === "application/json") {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return failed("json");
    }
    const work = route.verify(data);
    if (!work) return failed("content_or_rows");
    return { ...sample, readyMs: fullMs, work };
  }

  if (/NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|(?:^|\n)[\da-f]+:E\{"digest"/.test(body))
    return failed("stream_error");
  const markers = typeof route.markers === "function" ? route.markers(body) : route.markers;
  const offsets = markers.map((marker) => markerEnd(body, marker));
  if (offsets.some((end) => end === 0)) return failed("missing_marker");
  const byte = Buffer.byteLength(body.slice(0, Math.max(...offsets)));
  const readyMs = chunks.find(({ end }) => end >= byte).ms;
  const work = route.verify?.(body);
  if (work === null) return failed("content_or_rows");
  return { ...sample, readyMs, ...(work ? { work } : {}) };
}

function range(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1),
  };
}

export function summarize(samples) {
  const valid = samples.filter((sample) => !sample.error);
  return {
    valid: valid.length,
    failed: samples.length - valid.length,
    readyMs: range(valid.map((sample) => sample.readyMs)),
    fullMs: range(valid.map((sample) => sample.fullMs)),
    bytes: range(valid.map((sample) => sample.bytes)),
  };
}
