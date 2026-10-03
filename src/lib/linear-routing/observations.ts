import "server-only";

import { z } from "zod";

const endpoint = "https://api.linear.app/graphql";
const pageSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      stateId: z.string().min(1),
      startedAt: z.string().datetime({ offset: true }),
      endedAt: z.string().datetime({ offset: true }).nullable(),
    }),
  ),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
const issueSchema = z.object({
  id: z.string().min(1),
  updatedAt: z.string().datetime({ offset: true }),
  state: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  stateHistory: pageSchema,
});
const responseSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        extensions: z.object({ code: z.string().optional() }).optional(),
      }),
    )
    .optional(),
});
const fields = `id updatedAt state { id name }
  stateHistory(first: 50, after: $after) {
    nodes { id stateId startedAt endedAt }
    pageInfo { hasNextPage endCursor }
  }`;

export type LinearStateObservation = {
  issueUpdatedAt: string;
  spanId: string;
  startedAt: string;
  stateId: string;
  statusName: string;
};

export class LinearRateLimitedError extends Error {
  constructor() {
    super("Linear rate limit persisted after retry");
    this.name = "LinearRateLimitedError";
  }
}

async function request(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  sleep: (ms: number) => Promise<void>,
) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ query, variables }),
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = response.status === 429 ? null : responseSchema.parse(await response.json());
    if (
      response.status === 429 ||
      payload?.errors?.some((error) => error.extensions?.code === "RATELIMITED")
    ) {
      if (attempt >= 1) throw new LinearRateLimitedError();
      const seconds = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
      await sleep(
        Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 30_000) : 1_000,
      );
      continue;
    }
    if (!response.ok || payload?.errors?.length || !payload?.data) {
      throw new Error(
        `Linear observation request failed: ${payload?.errors?.map((error) => error.message).join("; ") ?? response.status}`,
      );
    }
    return payload.data;
  }
}

/** State-span identity survives unrelated edits and missed leave/return polls.
 * Paginate rather than assuming undocumented stateHistory ordering. A missing
 * or inconsistent open span fails closed and is retried on the next sweep.
 */
export async function fetchLinearStateObservations(
  apiKey: string,
  issueIds: string[],
  sleep: (ms: number) => Promise<void>,
): Promise<Map<string, LinearStateObservation>> {
  const result = new Map<string, LinearStateObservation>();
  if (issueIds.length === 0) return result;
  // issue(id:) accepts both UUIDs and human identifiers used by linked sessions.
  const definitions = issueIds.map((_, index) => `$id${index}: String!`).join(", ");
  const selections = issueIds
    .map((_, index) => `issue${index}: issue(id: $id${index}) { ${fields} }`)
    .join("\n");
  const data = await request(
    apiKey,
    `query IssueStateSpans(${definitions}, $after: String) { ${selections} }`,
    Object.fromEntries(issueIds.map((id, index) => [`id${index}`, id])),
    sleep,
  );
  for (const [index, issueId] of issueIds.entries()) {
    const raw = data[`issue${index}`];
    if (raw === null) continue;
    const initial = issueSchema.parse(raw);
    let page = initial.stateHistory;
    const cursors = new Set<string>();
    for (;;) {
      const open = page.nodes.filter((span) => span.endedAt === null);
      if (open.length > 0) {
        const span = open[0]!;
        if (
          open.length !== 1 ||
          span.stateId !== initial.state.id ||
          Date.parse(span.startedAt) > Date.parse(initial.updatedAt)
        ) {
          throw new Error(`Linear state history is inconsistent for ${issueId}`);
        }
        result.set(issueId, {
          issueUpdatedAt: initial.updatedAt,
          spanId: span.id,
          startedAt: span.startedAt,
          stateId: span.stateId,
          statusName: initial.state.name,
        });
        break;
      }
      const cursor = page.pageInfo.endCursor;
      if (!page.pageInfo.hasNextPage || !cursor || cursors.has(cursor) || cursors.size >= 100) {
        throw new Error(`Linear current state span unavailable for ${issueId}`);
      }
      cursors.add(cursor);
      const nextData = await request(
        apiKey,
        `query IssueStateSpans($id: String!, $after: String) { issue(id: $id) { ${fields} } }`,
        { id: initial.id, after: cursor },
        sleep,
      );
      const next = issueSchema.parse(nextData.issue);
      if (
        next.id !== initial.id ||
        next.updatedAt !== initial.updatedAt ||
        next.state.id !== initial.state.id ||
        next.state.name !== initial.state.name
      ) {
        throw new Error(`Linear issue changed while reading state history for ${issueId}`);
      }
      page = next.stateHistory;
    }
  }
  return result;
}
