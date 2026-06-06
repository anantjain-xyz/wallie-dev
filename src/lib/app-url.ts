const fallbackAppUrl = "https://www.wallie.dev";

type EnvInput = Record<string, string | undefined>;

function getRawAppUrl(input: EnvInput = process.env) {
  const value = input.NEXT_PUBLIC_APP_URL?.trim();

  return value || fallbackAppUrl;
}

export function resolveAppUrl(input?: EnvInput) {
  const url = new URL(getRawAppUrl(input));

  url.pathname = "/";
  url.search = "";
  url.hash = "";

  return url;
}

export function resolveAppOrigin(input?: EnvInput) {
  return resolveAppUrl(input).origin;
}

export function buildAppUrl(path: string, input?: EnvInput) {
  return new URL(path, resolveAppOrigin(input));
}
