import assert from "node:assert/strict";

const installation = process.env.SMOKE_INSTALLATION;
const other = installation === "a" ? "b" : "a";
const port = installation === "a" ? 3001 : 3002;
const origin = "http://127.0.0.1:3000";
const appUrl = `https://install-${installation}.wallie.invalid`;
const supabaseUrl = `http://127.0.0.1:${port}`;
const publicKey = `web-container-public-${installation}`;
const forbidden = [
  "web-container-private-canary",
  "web-container-github-private-canary",
  "ab".repeat(32),
  `web-container-public-${other}`,
  `https://install-${other}.wallie.invalid`,
  `http://127.0.0.1:${port === 3001 ? 3002 : 3001}`,
];
const get = (path, init = {}) =>
  fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(15_000) });
const assertPublic = (body) => {
  for (const value of forbidden)
    assert.ok(!body.includes(value), `Public response leaked ${value}`);
};

const response = await get("/");
const html = await response.text();
assert.equal(response.status, 200);
assert.match(response.headers.get("cache-control"), /no-store/);
assert.ok(html.includes(supabaseUrl) && html.includes(publicKey), "Runtime provider is missing");
assert.ok(html.includes(`content="${appUrl}/og-image.png"`), "Runtime metadata origin is missing");
assertPublic(html);
const rscResponse = await get("/", { headers: { RSC: "1" } });
const rsc = await rscResponse.text();
assert.equal(rscResponse.status, 200);
assert.match(rscResponse.headers.get("content-type"), /text\/x-component/);
assert.match(rscResponse.headers.get("cache-control"), /no-store/);
assert.ok(rsc.includes(supabaseUrl) && rsc.includes(publicKey), "RSC provider is missing");
assertPublic(rsc);
const devResponse = await get("/dev/ui-primitives");
await devResponse.text();
assert.equal(devResponse.status, 404, "Production fixtures must be unavailable");

const assets = new Set([
  ...[...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1].replaceAll("&amp;", "&"))
    .filter((url) => url.startsWith("/_next/static/")),
  "/icon-192.png",
  "/favicon.ico",
]);
assert.ok(
  [...assets].some((url) => url.endsWith(".js")),
  "No browser chunks found",
);
assert.ok(
  [...assets].some((url) => url.endsWith(".css")),
  "No stylesheets found",
);
for (const url of assets) {
  const asset = await get(url);
  const bytes = Buffer.from(await asset.arrayBuffer());
  assert.equal(asset.status, 200, `Missing asset ${url}`);
  assert.ok(bytes.length > 0);
  if (/\.(js|css)$/.test(url)) assertPublic(bytes.toString());
  if (url.endsWith(".css")) {
    for (const match of bytes.toString().matchAll(/url\(["']?([^\s)"']+\.woff2)["']?\)/g)) {
      assets.add(new URL(match[1], new URL(url, origin)).pathname);
    }
  }
}
assert.ok(
  [...assets].some((url) => url.endsWith(".woff2")),
  "No bundled fonts found",
);

const email = await get("/auth/email", {
  method: "POST",
  body: new URLSearchParams({ email: "container-smoke@example.invalid", next: "/w/smoke" }),
  redirect: "manual",
});
await email.text();
assert.equal(email.status, 303);
assert.ok(email.headers.get("location").includes("status=check_email"));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const expires = Math.floor(Date.now() / 1000) + 3600;
const token = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "00000000-0000-4000-8000-000000000001", exp: expires, aud: "authenticated" })}.c2lnbmF0dXJl`;
const cookie = `base64-${encode({ access_token: token, refresh_token: "synthetic-refresh", expires_at: expires, expires_in: 3600, token_type: "bearer" })}`;
const authenticated = await get("/container-smoke-missing-page", {
  headers: { cookie: `sb-127-auth-token=${cookie}` },
});
await authenticated.text();
const state = await (await fetch(`${supabaseUrl}/_smoke/state`)).json();
assert.deepEqual(state.errors, []);
const otp = state.calls.find((call) => call.url.startsWith("/auth/v1/otp"));
const user = state.calls.find((call) => call.url.startsWith("/auth/v1/user"));
assert.ok(otp && user, "Auth route and middleware must reach runtime Supabase");
assert.equal(otp.apikey, publicKey);
assert.equal(user.apikey, publicKey);
assert.equal(JSON.parse(otp.body).email, "container-smoke@example.invalid");
assert.equal(
  new URL(otp.url, supabaseUrl).searchParams.get("redirect_to"),
  `${appUrl}/auth/confirm?next=%2Fw%2Fsmoke`,
);

const avatar = "/storage/v1/object/public/workspace-avatars/smoke/avatar.png";
for (const [url, status] of [
  [`${supabaseUrl}${avatar}`, 200],
  [`${supabaseUrl}${avatar.replace("workspace-avatars", "profile-avatars")}`, 200],
  [`http://127.0.0.1:${port === 3001 ? 3002 : 3001}${avatar}`, 400],
  [`${supabaseUrl}${avatar.replace("workspace-avatars", "other")}`, 400],
  [`${supabaseUrl}${avatar}?download=1`, 400],
]) {
  const result = await get(`/_next/image?url=${encodeURIComponent(url)}&w=64&q=75`);
  const bytes = await result.arrayBuffer();
  assert.equal(result.status, status, `Image boundary failed for ${url}`);
  if (status === 200) {
    assert.equal(result.headers.get("content-type"), "image/png");
    assert.ok(bytes.byteLength > 0);
  }
}
console.log(
  `Installation ${installation}: runtime provider/metadata/auth, production guard, ${assets.size} assets, image boundaries passed.`,
);
