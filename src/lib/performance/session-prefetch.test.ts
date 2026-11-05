import { describe, expect, it } from "vitest";

import { SESSION_PAGE_DATA_SERVER_TIMING, sessionPageDataResponseEnd } from "./session-prefetch";

const origin = "http://localhost:3100";
const href = "/w/acme/sessions/7";

describe("completed session page-data evidence", () => {
  const resource = {
    decodedBodySize: 500,
    name: `${origin}${href}?_rsc=page`,
    responseEnd: 120,
    responseStatus: 200,
    serverTiming: [{ name: SESSION_PAGE_DATA_SERVER_TIMING }],
    startTime: 100,
    transferSize: 700,
  };

  it("uses only the successful marked body from the current intent and destination", () => {
    expect(sessionPageDataResponseEnd(resource, href, 90, origin)).toBe(120);
    expect(sessionPageDataResponseEnd(resource, "/w/acme/sessions/8", 90, origin)).toBeNull();
    expect(sessionPageDataResponseEnd(resource, href, 110, origin)).toBeNull();
    expect(
      sessionPageDataResponseEnd(
        { ...resource, name: `https://other.example${href}?_rsc=page` },
        href,
        90,
        origin,
      ),
    ).toBeNull();
  });

  it("keeps the fallback guard for unmarked, incomplete, failed, or unsupported entries", () => {
    const incomplete = [
      { ...resource, serverTiming: [] },
      { ...resource, serverTiming: undefined },
      { ...resource, responseStatus: undefined },
      { ...resource, responseStatus: 500 },
      { ...resource, responseEnd: 0 },
      { ...resource, decodedBodySize: 0, transferSize: 0 },
      { ...resource, name: `${origin}${href}` },
    ];
    for (const entry of incomplete) {
      expect(sessionPageDataResponseEnd(entry, href, 90, origin)).toBeNull();
    }
  });
});
