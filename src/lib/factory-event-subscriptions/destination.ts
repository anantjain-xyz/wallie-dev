declare const factoryEventDestination: unique symbol;
export type FactoryEventDestination = string & { readonly [factoryEventDestination]: true };

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const reservedSuffixes = [".localhost", ".local", ".internal", ".arpa", ".invalid", ".test"];

function isFactoryEventDestination(value: string): value is FactoryEventDestination {
  const url = new URL(value);
  const labels = url.hostname.split(".");
  const suffix = labels.at(-1);
  return (
    value.length <= 2048 &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !url.port &&
    url.hostname.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => dnsLabel.test(label)) &&
    Boolean(suffix && /[a-z]/.test(suffix)) &&
    !reservedSuffixes.some((reserved) => url.hostname.endsWith(reserved))
  );
}

export function parseFactoryEventDestination(value: string): FactoryEventDestination | null {
  if (
    value.length > 2048 ||
    /[\s\p{Cc}\\#]/u.test(value) ||
    !/^https:\/\/[^/?@]+(?:[/?]|$)/i.test(value)
  ) {
    return null;
  }
  const url = URL.parse(value);
  if (!url) return null;
  if (!url.search) url.search = "";
  return isFactoryEventDestination(url.href) ? url.href : null;
}
