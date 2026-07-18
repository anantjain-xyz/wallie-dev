import { existsSync, readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const nextDirectory = new URL("../.next/", import.meta.url);
const chunksDirectory = new URL("static/chunks/", nextDirectory);
const baseline = {
  commit: "5d75a98",
  gzipBytes: 112_346,
  rawBytes: 421_463,
};
const routes = ["pipeline", "sessions", "settings"];
// "pipeline" resolves to the canonical dashboard route group `(pipeline)` at the
// workspace root, not the legacy `pipeline/` redirect page — the redirect page's
// manifest would trivially omit the dialog and miss eager imports in PipelinePageClient.
const routeSegments = { pipeline: "(pipeline)", sessions: "sessions", settings: "settings" };
const commonLayoutEntry = "[project]/src/app/w/[workspaceSlug]/(app)/layout";

function readManifest(route) {
  const manifestUrl = new URL(
    `server/app/w/[workspaceSlug]/(app)/${routeSegments[route]}/page_client-reference-manifest.js`,
    nextDirectory,
  );

  if (!existsSync(manifestUrl)) {
    throw new Error(`Missing ${manifestUrl.pathname}. Run pnpm build first.`);
  }

  const context = {};
  context.globalThis = context;
  vm.runInNewContext(readFileSync(manifestUrl, "utf8"), context);

  const routeKey = Object.keys(context.__RSC_MANIFEST ?? {})[0];
  const manifest = routeKey ? context.__RSC_MANIFEST[routeKey] : null;
  if (!manifest) {
    throw new Error(`Could not read the RSC manifest for ${route}.`);
  }

  return manifest;
}

function chunkContents(chunk) {
  return readFileSync(new URL(chunk.replace(/^static\/chunks\//, ""), chunksDirectory));
}

function chunkSize(chunk) {
  const contents = chunkContents(chunk);
  return { gzipBytes: gzipSync(contents).length, rawBytes: contents.length };
}

const manifests = Object.fromEntries(routes.map((route) => [route, readManifest(route)]));
const commonChunks = manifests.pipeline.entryJSFiles[commonLayoutEntry];
if (!commonChunks) {
  throw new Error("The authenticated layout entry was not found in the pipeline manifest.");
}

const commonContents = Buffer.concat(commonChunks.map(chunkContents)).toString("utf8");
const forbiddenCommonMarkers = {
  Supabase: ["createSupabaseBrowserClient", "GoTrueClient"],
  Zod: ["ZodString", "ZodObject"],
};

for (const [dependency, markers] of Object.entries(forbiddenCommonMarkers)) {
  if (markers.some((marker) => commonContents.includes(marker))) {
    throw new Error(`${dependency} is still present in the authenticated layout chunks.`);
  }
}

const allClientChunks = readdirSync(chunksDirectory)
  .filter((file) => file.endsWith(".js"))
  .map((file) => `static/chunks/${file}`);
const dialogChunks = allClientChunks.filter((chunk) =>
  chunkContents(chunk).includes("Start a new session"),
);
if (dialogChunks.length === 0) {
  throw new Error("Could not identify the built create-session dialog chunk.");
}

const initialRouteChunks = {};
for (const route of routes) {
  const chunks = [...new Set(Object.values(manifests[route].entryJSFiles).flat())];
  const eagerDialogChunks = dialogChunks.filter((chunk) => chunks.includes(chunk));
  if (eagerDialogChunks.length > 0) {
    throw new Error(`${route} eagerly requests dialog chunks: ${eagerDialogChunks.join(", ")}`);
  }
  initialRouteChunks[route] = chunks;
}

const after = commonChunks.map(chunkSize).reduce(
  (total, size) => ({
    gzipBytes: total.gzipBytes + size.gzipBytes,
    rawBytes: total.rawBytes + size.rawBytes,
  }),
  { gzipBytes: 0, rawBytes: 0 },
);

console.log(
  JSON.stringify(
    {
      authenticatedCommonRoute: {
        after,
        before: baseline,
        delta: {
          gzipBytes: after.gzipBytes - baseline.gzipBytes,
          rawBytes: after.rawBytes - baseline.rawBytes,
        },
        initialChunks: commonChunks,
        verifiedAbsent: Object.keys(forbiddenCommonMarkers),
      },
      createSessionDialog: {
        asyncChunks: dialogChunks.map((chunk) => ({ chunk, ...chunkSize(chunk) })),
        absentFromInitialRoutes: Object.keys(initialRouteChunks),
      },
    },
    null,
    2,
  ),
);
