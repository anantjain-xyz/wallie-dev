import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      "account-id": { type: "string" },
      region: { type: "string" },
      "vpc-id": { type: "string" },
      "expires-at": { type: "string" },
    },
  });
  if (
    positionals.length !== 0 ||
    tokens.filter((token) => token.kind === "option").length !== 4 ||
    Object.keys(values).length !== 4
  ) {
    throw new Error("Use --account-id, --region, --vpc-id, and --expires-at exactly once");
  }
  const { "account-id": account, region, "vpc-id": vpc, "expires-at": expiresAt } = values;
  if (typeof account !== "string" || !/^[0-9]{12}$/.test(account))
    throw new Error("Invalid --account-id");
  if (typeof region !== "string" || !/^(?!cn-|us-gov-|us-iso-)[a-z]{2}-[a-z]+-[0-9]+$/.test(region))
    throw new Error("Invalid commercial --region");
  if (typeof vpc !== "string" || !/^vpc-[a-f0-9]{17}$/.test(vpc))
    throw new Error("Invalid --vpc-id");
  if (typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresAt))
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

  const replacements = { ACCOUNT_ID: account, REGION: region, VPC_ID: vpc };
  const template = readFileSync(
    new URL("../infra/aws/supabase-connectivity-policy.template.json", import.meta.url),
    "utf8",
  );
  const rendered = template.replace(/<([A-Z_]+)>/g, (_, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`Unknown policy placeholder: ${key}`);
    return replacements[key];
  });
  const policy = JSON.parse(rendered);
  for (const statement of policy.Statement) {
    statement.Condition.DateLessThan = { "aws:CurrentTime": expiresAt };
  }
  if (JSON.stringify(policy).length > 6144)
    throw new Error("Rendered policy exceeds IAM's 6,144-character managed-policy limit");
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(`[aws-supabase-connectivity] ${error.message}`);
  process.exitCode = 1;
}
