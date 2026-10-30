/**
 * Worker stand-in for `undici`.
 *
 * `@vercel/sandbox` constructs an `Agent` at import time and passes it as
 * `RequestInit.dispatcher`. Cloudflare owns connection pooling, and its fetch
 * ignores that option, so the pool is a no-op.
 *
 * E2B dynamically imports `undici` and calls its `fetch` with a dispatcher.
 * Delegate to the global fetch (dropping `dispatcher`) so those calls use the
 * worker runtime and test stubs. A `.mjs` file loads from the Vitest module
 * fallback; the previous `.ts` alias failed from an anonymous referrer.
 */

export class Agent {
  constructor(_options) {
    void _options;
  }

  async close() {}
}

export class ProxyAgent extends Agent {}

export function fetch(input, init) {
  if (!init || !Object.hasOwn(init, "dispatcher")) return globalThis.fetch(input, init);
  const rest = { ...init };
  delete rest.dispatcher;
  return globalThis.fetch(input, rest);
}
