import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverOnlyEntryPath = fileURLToPath(import.meta.resolve("server-only"));
const serverOnlyEmptyPath = path.join(path.dirname(serverOnlyEntryPath), "empty.js");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (request === "server-only") {
    return serverOnlyEmptyPath;
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};
