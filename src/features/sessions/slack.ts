export function buildSlackThreadHref(
  channelId: string | null,
  threadTs: string | null,
): string | null {
  if (!channelId || !threadTs) {
    return null;
  }
  const tsForUrl = threadTs.replace(".", "");
  return `https://app.slack.com/client/redirect?team=&url=${encodeURIComponent(
    `slack://channel?id=${channelId}&message=${tsForUrl}`,
  )}`;
}
