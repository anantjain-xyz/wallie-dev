// Preloaded via `node --import` ahead of the worker's module graph so that
// even import-time / top-level evaluation failures (e.g. a throw while loading
// `@/lib/supabase/admin` or `src/worker/loop`) are reported with a stack. If we
// registered these handlers from inside the entry module instead, its static
// ESM imports would be evaluated first and an import-time crash would never
// reach them — leaving only pnpm's generic `ELIFECYCLE Command failed`.

/**
 * Log a process-level fatal with its full stack, then exit non-zero so the
 * platform can restart us cleanly. Process state is undefined after these
 * events, so continuing is unsafe.
 */
function reportFatalAndExit(label, detail) {
  const detailText = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
  process.exitCode = 1;

  // `process.exit()` can truncate not-yet-flushed writes to a piped stderr
  // (Railway/pnpm logs) — losing the very stack trace these handlers exist to
  // capture. Write the diagnostic, exit from the flush callback, and keep an
  // unref'd fallback in case the callback never fires.
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    process.exit(1);
  };

  process.stderr.write(`[worker] ${label}\n${detailText}\n`, exit);
  setTimeout(exit, 1000).unref();
}

process.on("uncaughtException", (error) => {
  reportFatalAndExit("uncaught exception — exiting", error);
});

process.on("unhandledRejection", (reason) => {
  reportFatalAndExit("unhandled rejection — exiting", reason);
});
