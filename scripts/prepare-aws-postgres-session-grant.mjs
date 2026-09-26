import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const commonOptions = ["policy", "account-id", "region", "expires-at"];
const networkOptions = ["vpc-id", "database-security-group-id", "logs-endpoint-id"];
const templates = {
  network: "../infra/aws/postgres-session-network-grant-policy.template.json",
  host: "../infra/aws/postgres-session-host-grant-policy.template.json",
};

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries(
      [...commonOptions, ...networkOptions].map((name) => [name, { type: "string" }]),
    ),
  });
  const policyName = values.policy;
  if (!Object.hasOwn(templates, policyName)) throw new Error("Use --policy network or host");
  const required = policyName === "network" ? [...commonOptions, ...networkOptions] : commonOptions;
  if (
    positionals.length !== 0 ||
    tokens.filter((token) => token.kind === "option").length !== required.length ||
    Object.keys(values).length !== required.length ||
    required.some(
      (name) => typeof values[name] !== "string" || values[name] !== values[name].trim(),
    )
  ) {
    throw new Error(
      `Provide each option exactly once: ${required.map((name) => `--${name}`).join(" ")}`,
    );
  }

  const account = values["account-id"];
  const region = values.region;
  const expiresAt = values["expires-at"];
  if (!/^[0-9]{12}$/.test(account)) throw new Error("Invalid --account-id");
  if (!/^(?!cn-|us-gov-|us-iso-)[a-z]{2}-[a-z]+-[0-9]+$/.test(region))
    throw new Error("Invalid commercial --region");
  if (policyName === "network") {
    for (const [name, prefix] of [
      ["vpc-id", "vpc"],
      ["database-security-group-id", "sg"],
      ["logs-endpoint-id", "vpce"],
    ]) {
      if (!new RegExp(`^${prefix}-[a-f0-9]{17}$`).test(values[name]))
        throw new Error(`Invalid --${name}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresAt))
    throw new Error("Invalid UTC --expires-at");
  const expiration = Date.parse(expiresAt);
  const remaining = expiration - Date.now();
  if (
    !Number.isFinite(expiration) ||
    new Date(expiration).toISOString() !== expiresAt.replace(/Z$/, ".000Z") ||
    remaining < 2 * 60 * 60 * 1000 ||
    remaining > 24 * 60 * 60 * 1000
  ) {
    throw new Error("--expires-at must be a real UTC time 2 to 24 hours from now");
  }

  const replacements = Object.fromEntries(
    required
      .filter((name) => name !== "policy" && name !== "expires-at")
      .map((name) => [name.replaceAll("-", "_").toUpperCase(), values[name]]),
  );
  const template = readFileSync(new URL(templates[policyName], import.meta.url), "utf8");
  const rendered = template.replace(/<([A-Z_]+)>/g, (_, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`Unknown policy placeholder: ${key}`);
    return replacements[key];
  });
  const policy = JSON.parse(rendered);
  for (const statement of policy.Statement) {
    statement.Condition.DateLessThan = { "aws:CurrentTime": expiresAt };
  }
  if (JSON.stringify(policy).length > 6_144)
    throw new Error("Rendered policy exceeds IAM's 6,144-character managed-policy limit");
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(`[aws-postgres-session-grant] ${error.message}`);
  process.exitCode = 1;
}
