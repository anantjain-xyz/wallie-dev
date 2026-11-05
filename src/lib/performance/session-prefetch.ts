export const SESSION_PAGE_DATA_SERVER_TIMING = "wallie_session_page_data";

type SessionPageDataResource = {
  decodedBodySize: number;
  name: string;
  responseEnd: number;
  responseStatus?: number;
  serverTiming?: readonly { name: string }[];
  startTime: number;
  transferSize: number;
};

export function sessionPageDataResponseEnd(
  resource: SessionPageDataResource,
  href: string,
  intentStartedAt: number,
  origin: string,
) {
  if (
    resource.startTime < intentStartedAt ||
    resource.responseEnd <= 0 ||
    resource.responseStatus !== 200 ||
    (resource.decodedBodySize <= 0 && resource.transferSize <= 0) ||
    !resource.serverTiming?.some((entry) => entry.name === SESSION_PAGE_DATA_SERVER_TIMING)
  ) {
    return null;
  }

  try {
    const url = new URL(resource.name);
    const destination = new URL(href, origin);
    return url.origin === origin &&
      destination.origin === origin &&
      url.pathname === destination.pathname &&
      url.searchParams.has("_rsc")
      ? resource.responseEnd
      : null;
  } catch {
    return null;
  }
}
