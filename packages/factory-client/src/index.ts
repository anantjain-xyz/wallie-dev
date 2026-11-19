import { factoryOperations, type FactoryOperationId } from "./operations.js";
import type { components, operations } from "./schema.js";

export type { FactoryOperationId } from "./operations.js";
export type { components, operations, paths } from "./schema.js";

type JsonContent<T> = T extends { content: { "application/json": infer Body } } ? Body : never;
export type FactoryResponse<I extends FactoryOperationId> = JsonContent<
  operations[I]["responses"][200]
>;
export type FactoryBody<I extends FactoryOperationId> = operations[I] extends {
  requestBody: infer Body;
}
  ? JsonContent<Body>
  : never;
export type FactoryQuery<I extends FactoryOperationId> = operations[I] extends {
  parameters: { query?: infer Query };
}
  ? Query
  : never;
export type FactoryErrorCode =
  | components["schemas"]["Error"]["code"]
  | components["schemas"]["MutationError"]["code"];

export type FactorySession = FactoryResponse<"getFactorySession">;
export type FactoryRun = FactoryResponse<"getFactoryRun">;
export type FactoryArtifact = FactoryResponse<"getFactoryArtifact">;
export type FactoryConversation = FactoryResponse<"listFactoryConversation">;
export type FactoryMutationReceipt = FactoryResponse<"createFactorySession">;

export type FactoryRequestOptions = { signal?: AbortSignal };
export type FactoryMutationOptions = FactoryRequestOptions & { idempotencyKey: string };
export type FactoryClientOptions = {
  baseUrl: string;
  workspaceId: string;
  factoryId: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
};

export class FactoryApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "FactoryApiError";
  }
}

export class FactoryTransportError extends Error {
  constructor(readonly code: "transport_error" | "invalid_response") {
    super(
      code === "transport_error"
        ? "Could not reach Wallie."
        : "Wallie returned an invalid JSON response.",
    );
    this.name = "FactoryTransportError";
  }
}

const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function exactId(value: string, field: string) {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new TypeError(`Provide a valid ${field} UUID.`);
  return value.toLowerCase();
}

function apiOrigin(baseUrl: string) {
  const invalidOrigin = "Provide an HTTPS Wallie origin, or an HTTP loopback origin for local use.";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(invalidOrigin);
  }
  if (
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname)))
  ) {
    throw new TypeError(invalidOrigin);
  }
  return url.origin;
}

function integerWithin(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readHttpError(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  const body = isRecord(payload) ? payload : {};
  const code =
    typeof body.code === "string" && /^[a-z_]{1,64}$/.test(body.code)
      ? body.code
      : "unexpected_response";
  const message =
    typeof body.error === "string" && body.error.length <= 500
      ? body.error
      : "Wallie rejected the request.";
  const retryHeader = response.headers.get("Retry-After") ?? "";
  const retrySeconds = /^[1-9][0-9]{0,8}$/.test(retryHeader)
    ? Number(retryHeader)
    : body.retryAfterSeconds;
  const retryAfterSeconds =
    typeof retrySeconds === "number" && Number.isSafeInteger(retrySeconds) && retrySeconds > 0
      ? retrySeconds
      : undefined;
  return new FactoryApiError(response.status, code, message, retryAfterSeconds);
}

type RequestInput = FactoryRequestOptions & {
  path?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  idempotencyKey?: string;
};

export class FactoryClient {
  readonly #origin: string;
  readonly #scope: Readonly<{ workspaceId: string; factoryId: string }>;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;

  constructor(options: FactoryClientOptions) {
    this.#origin = apiOrigin(options.baseUrl);
    this.#scope = {
      workspaceId: exactId(options.workspaceId, "workspace"),
      factoryId: exactId(options.factoryId, "factory"),
    };
    if (typeof options.token !== "string" || !/^[A-Za-z0-9_.~-]+$/.test(options.token)) {
      throw new TypeError("Provide a Wallie machine token or OAuth access token.");
    }
    this.#authorization = `Bearer ${options.token}`;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = integerWithin(options.timeoutMs ?? 15_000, 1, 120_000, "timeoutMs");
    this.#maxAttempts = integerWithin(options.maxAttempts ?? 2, 1, 3, "maxAttempts");
  }

  toUrl(path: string) {
    const url = new URL(path, this.#origin);
    if (url.origin !== this.#origin || url.username || url.password) {
      throw new TypeError("Use a link on the configured Wallie origin.");
    }
    return url.href;
  }

  listSessions(query?: FactoryQuery<"listFactorySessions">, options?: FactoryRequestOptions) {
    return this.#request("listFactorySessions", { ...options, query });
  }

  getSession(sessionId: string, options?: FactoryRequestOptions) {
    return this.#request("getFactorySession", { ...options, path: { sessionId } });
  }

  listRuns(query?: FactoryQuery<"listFactoryRuns">, options?: FactoryRequestOptions) {
    return this.#request("listFactoryRuns", { ...options, query });
  }

  getRun(runId: string, options?: FactoryRequestOptions) {
    return this.#request("getFactoryRun", { ...options, path: { runId } });
  }

  getArtifact(sessionId: string, artifactId: string, options?: FactoryRequestOptions) {
    return this.#request("getFactoryArtifact", {
      ...options,
      path: { sessionId, artifactId },
    });
  }

  getConversation(
    sessionId: string,
    query?: FactoryQuery<"listFactoryConversation">,
    options?: FactoryRequestOptions,
  ) {
    return this.#request("listFactoryConversation", {
      ...options,
      path: { sessionId },
      query,
    });
  }

  createSession(body: FactoryBody<"createFactorySession">, options: FactoryMutationOptions) {
    return this.#request("createFactorySession", { ...options, body });
  }

  sendFollowUp(
    sessionId: string,
    body: FactoryBody<"followUpFactorySession">,
    options: FactoryMutationOptions,
  ) {
    return this.#request("followUpFactorySession", {
      ...options,
      path: { sessionId },
      body,
    });
  }

  answerClarification(
    sessionId: string,
    clarificationId: string,
    body: FactoryBody<"answerFactorySessionClarification">,
    options: FactoryMutationOptions,
  ) {
    return this.#request("answerFactorySessionClarification", {
      ...options,
      path: { sessionId, clarificationId },
      body,
    });
  }

  cancelSession(
    sessionId: string,
    body: FactoryBody<"cancelFactorySession">,
    options: FactoryMutationOptions,
  ) {
    return this.#request("cancelFactorySession", {
      ...options,
      path: { sessionId },
      body,
    });
  }

  async #request<I extends FactoryOperationId>(
    operation: I,
    input: RequestInput,
  ): Promise<FactoryResponse<I>> {
    const definition = factoryOperations[operation];
    const ids: Record<string, string> = { ...input.path, ...this.#scope };
    const path = definition.path.replace(/\{([a-zA-Z]+)\}/g, (_match, field: string) =>
      exactId(ids[field], field),
    );
    const url = new URL(path, this.#origin);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: this.#authorization,
    };
    let body: string | undefined;
    if (definition.requiresIdempotencyKey) {
      headers["content-type"] = "application/json";
      headers["idempotency-key"] = exactId(input.idempotencyKey ?? "", "idempotency key");
      body = JSON.stringify(input.body);
      if (body === undefined) throw new TypeError("Provide a JSON request body.");
    }

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      input.signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(this.#timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
      let response: Response | undefined;
      try {
        response = await this.#fetch(url.href, {
          method: definition.method,
          body,
          headers: { ...headers },
          redirect: "manual",
          signal,
        });
        if (!response.ok) throw await readHttpError(response);
        const payload: unknown = await response.json();
        if (!isRecord(payload)) throw new FactoryTransportError("invalid_response");
        return payload as FactoryResponse<I>;
      } catch (error) {
        if (error instanceof FactoryApiError || error instanceof FactoryTransportError) throw error;
        input.signal?.throwIfAborted();
        if (response && error instanceof SyntaxError && !deadline.aborted) {
          throw new FactoryTransportError("invalid_response");
        }
      }
    }
    throw new FactoryTransportError("transport_error");
  }
}
