import { expect, test, type CDPSession, type Page, type TestInfo } from "@playwright/test";

const TRACE_EVENT_NAMES = new Set(["UpdateLayoutTree", "Layout", "PrePaint", "Paint"]);

type TraceEvent = {
  dur?: number;
  name?: string;
  ph?: string;
};

type TraceResult = {
  durationMs: number;
  eventCount: number;
  mode: "baseline" | "contained";
};

async function readProtocolStream(client: CDPSession, handle: string) {
  let trace = "";
  let eof = false;

  while (!eof) {
    const chunk = await client.send("IO.read", { handle });
    trace += chunk.data;
    eof = chunk.eof;
  }

  await client.send("IO.close", { handle });
  return trace;
}

async function captureRenderingTrace(
  page: Page,
  mode: TraceResult["mode"],
  testInfo: TestInfo,
): Promise<TraceResult> {
  const client = await page.context().newCDPSession(page);
  const traceComplete = new Promise<{ stream?: string }>((resolve) => {
    client.once("Tracing.tracingComplete", resolve);
  });

  await client.send("Tracing.start", {
    categories: "devtools.timeline",
    transferMode: "ReturnAsStream",
  });
  await page.goto(`/dev/content-visibility?mode=${mode}`);
  await expect(page.locator("[data-benchmark-mode]")).toHaveAttribute("data-benchmark-mode", mode);
  await expect(page.locator(".session-list-row")).toHaveCount(120);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await client.send("Tracing.end");

  const { stream } = await traceComplete;
  if (!stream) throw new Error("Chrome did not return a rendering trace stream.");
  const rawTrace = await readProtocolStream(client, stream);
  await testInfo.attach(`content-visibility-${mode}-trace.json`, {
    body: Buffer.from(rawTrace),
    contentType: "application/json",
  });
  await client.detach();

  const events = (JSON.parse(rawTrace) as { traceEvents: TraceEvent[] }).traceEvents.filter(
    (event) => event.ph === "X" && event.name && TRACE_EVENT_NAMES.has(event.name),
  );

  return {
    durationMs: Number(
      (events.reduce((total, event) => total + (event.dur ?? 0), 0) / 1000).toFixed(2),
    ),
    eventCount: events.length,
    mode,
  };
}

test("reduces initial rendering work for a seeded 120-row page", async ({ page }, testInfo) => {
  await page.goto("/dev/content-visibility?mode=baseline");
  await page.goto("/dev/content-visibility?mode=contained");

  const baseline = await captureRenderingTrace(page, "baseline", testInfo);
  const contained = await captureRenderingTrace(page, "contained", testInfo);

  console.log(`content-visibility-benchmark ${JSON.stringify({ baseline, contained })}`);
  expect(contained.durationMs).toBeLessThan(baseline.durationMs);
});
