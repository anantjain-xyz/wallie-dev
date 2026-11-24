// Closed provider transport used only by the disposable M12 app and worker processes.
const databaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL);
const linear = process.env.WALLIE_M12_LINEAR_ENDPOINT
  ? new URL(process.env.WALLIE_M12_LINEAR_ENDPOINT)
  : null;
for (const endpoint of [databaseOrigin, appOrigin, ...(linear ? [linear] : [])]) {
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("M12 transport requires loopback HTTP endpoints.");
  }
}
const fetchLocal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === databaseOrigin.origin || url.origin === appOrigin.origin) {
    return fetchLocal(input, { ...init, redirect: "error" });
  }
  if (linear && url.href === "https://api.linear.app/graphql" && typeof input === "string") {
    return fetchLocal(linear, { ...init, redirect: "error" });
  }
  throw new Error("M12 fixture blocked an unconfigured external HTTP request.");
};
