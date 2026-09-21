/** Validate pgTAP output from unaligned, tuples-only psql, ignoring setup rows. */
export function assertTapPassed(output, label) {
  const fail = (reason) => {
    // Setup rows can contain connection settings, so never echo the SQL output.
    throw new Error(`${label}: ${reason}`);
  };
  let planned;
  let planPosition;
  let assertions = 0;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^Bail out!/i.test(line)) fail("TAP bailout");
    // Qualification requires passing assertions; even TODO failures are failures.
    if (/^not\s+ok\b/.test(line)) fail("TAP assertion failed");
    if (/^1\.\./.test(line)) {
      const plan = /^1\.\.(\d+)(?:\s+#.*)?$/.exec(line);
      if (!plan || planned !== undefined) fail("Invalid or duplicate TAP plan");
      planned = Number(plan[1]);
      planPosition = assertions;
      if (!Number.isSafeInteger(planned) || planned < 1) fail("TAP plan must contain assertions");
    } else if (/^ok(?:\s|$)/.test(line)) {
      const assertion = /^ok\s+([1-9]\d*)(?:\s|$)/.exec(line);
      if (!assertion || Number(assertion[1]) !== assertions + 1) {
        fail("TAP assertions must be numbered consecutively from 1");
      }
      if (/#\s*(?:SKIP|TODO)\b/i.test(line)) fail("Skipped or TODO TAP assertions do not qualify");
      assertions += 1;
    }
  }
  if (planned === undefined) fail("Missing TAP plan");
  if (assertions === 0 || assertions !== planned)
    fail("TAP assertion count does not match its plan");
  if (planPosition !== 0 && planPosition !== assertions)
    fail("TAP plan must precede or follow assertions");
  return assertions;
}
