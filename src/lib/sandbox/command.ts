import type { SandboxLogEntry } from "./types";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function shellJoin(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

export function shellEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return "";

  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid sandbox environment variable name: ${key}`);
    }
    return `${key}=${shellQuote(value)}`;
  });
  return `env ${assignments.join(" ")} `;
}

export function redactSecrets(message: string, secrets: Array<string | undefined>): string {
  const variants = secrets
    .filter((secret): secret is string => Boolean(secret && secret.length >= 4))
    .flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]);
  // Longest first prevents overlapping credentials from leaving the suffix of
  // a longer secret visible after a shorter prefix has already been replaced.
  return [...new Set(variants)]
    .sort((left, right) => right.length - left.length)
    .reduce((redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"), message);
}

/** Small replaying async queue used to bridge callback-based provider logs. */
export class SandboxLogBuffer {
  private readonly entries: SandboxLogEntry[] = [];
  private closed = false;
  private readonly waiters = new Set<() => void>();

  push(entry: SandboxLogEntry): void {
    if (this.closed) return;
    this.entries.push(entry);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  stream(): AsyncIterable<SandboxLogEntry> {
    const entries = this.entries;
    const isClosed = () => this.closed;
    const waiters = this.waiters;
    return {
      async *[Symbol.asyncIterator]() {
        let index = 0;
        while (true) {
          while (index < entries.length) {
            yield entries[index++]!;
          }
          if (isClosed()) return;
          await new Promise<void>((resolve) => waiters.add(resolve));
        }
      },
    };
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
