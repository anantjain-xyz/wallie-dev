export function withCatalogSignal<Query extends { abortSignal(signal: AbortSignal): Query }>(
  query: Query,
  signal: AbortSignal | undefined,
): Query {
  return signal ? query.abortSignal(signal) : query;
}
