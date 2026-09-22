import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

// Run inside each final image, offline, without starting an agent or authentication.
const require = createRequire(join(process.cwd(), "package.json"));
assert.ok(process.report.getReport().header.glibcVersionRuntime, "Runtime must provide glibc");
const locales = ["de", "ja", "hi"];
assert.deepEqual(
  Intl.DateTimeFormat.supportedLocalesOf(locales),
  locales,
  "Full ICU data must ship",
);
// Local Codex device authentication invokes the unversioned npm command.
assert.match(
  execFileSync("npm", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(),
  /^\d+\.\d+\.\d+$/,
);
const input = Buffer.from("Wallie runtime compression check");
assert.deepEqual(gunzipSync(gzipSync(input)), input);

const nextRequire = createRequire(require.resolve("next/package.json"));
const sharp = nextRequire("sharp");
const png = await sharp({
  create: { width: 2, height: 2, channels: 3, background: "#123456" },
})
  .resize(1, 1)
  .png()
  .toBuffer();
assert.equal((await sharp(png).metadata()).width, 1);

// Load the native binding explicitly: a WebAssembly fallback would hide ABI failures.
const swc = nextRequire(`@next/swc-linux-${process.arch}-gnu`);
const transformed = swc.transformSync(
  "const count: number = 7;",
  false,
  Buffer.from(JSON.stringify({ jsc: { parser: { syntax: "typescript" }, target: "es2022" } })),
);
assert.match(transformed.code, /const count = 7/);

const cursorRequire = createRequire(require.resolve("@cursor/sdk"));
const cursorRoot = dirname(cursorRequire.resolve(`@cursor/sdk-linux-${process.arch}/package.json`));
for (const binding of ["tree-sitter", "tree-sitter-bash"]) {
  assert.ok(require(join(cursorRoot, "vendor", binding, "binding.node")));
}
console.log("Native runtime compatibility checks passed");
