export const fixture = {
  workspace: "b1b2c3d4-0001-4000-8000-000000000001",
  slug: "acme-corp",
  factory: "e1b2c3d4-0001-4000-8000-000000000001",
  email: "anant@example.com",
};

const workspace = `/w/${fixture.slug}`;
const ledger = `${workspace}/sessions`;
export const pipelineApi = `/api/workspaces/${fixture.workspace}/pipeline-dashboard?factory=${fixture.factory}`;

const doc = "text/html";
const flight = "text/x-component";
const json = "application/json";
const shortTitle = "[wall-audit] Checkout latency short";
const longTitle = "[wall-audit] Checkout latency long";
const laneLimit = 25;
const ledgerLimit = 50;

const eligible = (n, filtered) =>
  n % 10 !== 0 && (!filtered || (n % 5 !== 0 && Math.floor((n - 1) / 4) % 4 === 0));
const heading = (title) => new RegExp(`<h1\\b[^>]*>\\s*${title}\\s*</h1>`);
const pipelineHeading = heading("Pipeline");
const selectedBoard =
  /<nav\b[^>]*aria-label="Sessions views"[^>]*>(?:(?!<\/nav>)[\s\S])*?<span\b[^>]*aria-current="page"[^>]*>\s*Board\s*<\/span>/;

function listLinks(body, names) {
  return [...body.matchAll(/<a\b[^>]*>/g)]
    .filter(([tag]) => names.test(tag))
    .map(([tag]) => Number(tag.match(/href="\/w\/acme-corp\/sessions\/(\d+)(?:\?[^"]*)?"/)?.[1]));
}

function checkNumbers(numbers, volume, filtered) {
  return (
    new Set(numbers).size === numbers.length &&
    numbers.every(
      (number) =>
        (number >= 1 && number <= 18) ||
        (number > 1000 && number <= 1000 + volume && eligible(number - 1000, filtered)),
    ) &&
    numbers.includes(1001) &&
    numbers.includes(1002)
  );
}

export function runtimeCases(volume) {
  const large = volume === 3200;
  const active = 17 + volume - volume / 10;
  const awaiting =
    8 +
    Array.from({ length: volume }, (_, i) => i + 1).filter((number) => eligible(number, true))
      .length;

  function snapshot(filtered) {
    return (data) => {
      if (
        data?.hasAnySession !== true ||
        !Array.isArray(data.lanes) ||
        data.lanes.length !== 4 ||
        !data.lanes.every(
          (lane, index) =>
            lane?.position === index + 1 &&
            Number.isInteger(lane.totalCount) &&
            lane.totalCount > 0 &&
            Array.isArray(lane.cards) &&
            lane.cards.length === Math.min(laneLimit, lane.totalCount) &&
            (lane.totalCount > laneLimit
              ? typeof lane.cursor === "string" && !!lane.cursor
              : lane.cursor === null) &&
            lane.cards.every(
              (card) =>
                card?.workspaceId === fixture.workspace &&
                card.currentStageId === lane.id &&
                (!filtered ||
                  (card.phaseStatus === "awaiting_review" && card.latestRunStatus !== "error")),
            ),
        )
      )
        return null;
      const matching = data.lanes.reduce((sum, lane) => sum + lane.totalCount, 0);
      const cards = data.lanes.flatMap((lane) => lane.cards);
      if (
        matching !== (filtered ? awaiting : active) ||
        !checkNumbers(
          cards.map((card) => card.number),
          volume,
          filtered,
        ) ||
        !cards.some((card) => card.number === 1001 && card.title === shortTitle) ||
        !cards.some((card) => card.number === 1002 && card.title === longTitle)
      )
        return null;
      return { rows: cards.length, matching };
    };
  }

  function ledgerCase(filtered) {
    return {
      name: filtered ? "ledger-awaiting-document" : "ledger-document",
      path: filtered ? `${ledger}?status=awaiting_review` : ledger,
      type: doc,
      maxBytes: filtered ? (large ? 312_000 : 260_000) : 305_000,
      markers: [heading("Sessions"), `aria-label="Open session #1001: ${shortTitle}"`],
      verify(body) {
        const numbers = listLinks(body, /aria-label="Open session #\d+: /);
        const synthetic = numbers.filter((number) => number > 1000);
        return numbers.length === Math.min(ledgerLimit, filtered ? awaiting : active) &&
          synthetic.every((number, index) => index === 0 || number > synthetic[index - 1]) &&
          (filtered || numbers.includes(1006)) &&
          checkNumbers(numbers, volume, filtered)
          ? { rows: numbers.length }
          : null;
      },
    };
  }

  function detail(length, type, maxBytes) {
    const long = length === "long";
    const document = type === doc;
    const title = long ? longTitle : shortTitle;
    const artifactTitle = `Wallie audit artifact ${length}`;
    return {
      name: `detail-${length}-${document ? "document" : "flight"}`,
      path: `${ledger}/${long ? 1002 : 1001}${document ? "" : "?_rsc"}`,
      type,
      maxBytes,
      markers: document
        ? [title, new RegExp(`<h1\\b[^>]*>\\s*<span[^>]*>${artifactTitle}</span>\\s*</h1>`)]
        : [title, artifactTitle],
      verify(body) {
        const content = long
          ? document
            ? /<h3\b[^>]*>[^<]*<span[^>]*>Timing checkpoint 640<\/span>/.test(body)
            : body.includes("Timing checkpoint 640")
          : body.includes("Checkout waits for inventory, tax, and shipping.");
        return content ? undefined : null;
      },
    };
  }

  return [
    {
      name: "pipeline-document",
      path: workspace,
      type: doc,
      maxBytes: large ? 345_000 : 325_000,
      markers: (body) => [
        ...(pipelineHeading.test(body) ? [pipelineHeading] : [heading("Sessions"), selectedBoard]),
        'aria-label="Pipeline board"',
        /aria-label="(?:Open|Review) session \[wall-audit\] Checkout latency short"/,
      ],
      verify(body) {
        const numbers = listLinks(
          body,
          pipelineHeading.test(body)
            ? /aria-label="Open session /
            : /aria-label="(?:Open|Review) session /,
        );
        return numbers.length === 4 * laneLimit && checkNumbers(numbers, volume, false)
          ? { rows: numbers.length }
          : null;
      },
    },
    ledgerCase(false),
    ledgerCase(true),
    detail("short", doc, 126_000),
    detail("long", doc, 850_000),
    detail("short", flight, 57_000),
    detail("long", flight, 440_000),
    {
      name: "pipeline-json",
      path: pipelineApi,
      type: json,
      maxBytes: 64_000,
      verify: snapshot(false),
    },
    {
      name: "pipeline-awaiting-json",
      path: `${pipelineApi}&status=awaiting_review`,
      type: json,
      maxBytes: large ? 64_000 : 27_000,
      verify: snapshot(true),
    },
  ];
}
