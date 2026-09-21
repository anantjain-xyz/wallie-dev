import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const fields = {
  "account-id": ["ACCOUNT_ID", /^\d{12}$/],
  region: ["REGION", /^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/],
  "vpc-id": ["VPC_ID", /^vpc-(?:[a-f0-9]{8}|[a-f0-9]{17})$/],
  "default-security-group-id": ["DEFAULT_SECURITY_GROUP_ID", /^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/],
  "default-network-acl-id": ["DEFAULT_NETWORK_ACL_ID", /^acl-(?:[a-f0-9]{8}|[a-f0-9]{17})$/],
  "sandbox-subnet-a-id": ["SANDBOX_SUBNET_A_ID", /^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/],
  "sandbox-subnet-b-id": ["SANDBOX_SUBNET_B_ID", /^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/],
};
const usage = `Usage: node scripts/prepare-aws-network-hardening.mjs ${Object.keys(fields)
  .map((key) => `--${key} <value>`)
  .join(" ")}`;

function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries(Object.keys(fields).map((key) => [key, { type: "string" }])),
  });
  if (
    positionals.length !== 0 ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(fields).length ||
    Object.entries(fields).some(([key, [, pattern]]) => !pattern.test(values[key] ?? "")) ||
    values["sandbox-subnet-a-id"] === values["sandbox-subnet-b-id"]
  ) {
    throw new Error(usage);
  }
  const replacements = Object.fromEntries(
    Object.entries(fields).map(([key, [placeholder]]) => [placeholder, values[key]]),
  );
  replacements.PARTITION = values.region.startsWith("cn-")
    ? "aws-cn"
    : values.region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const template = readFileSync(
    new URL("../infra/aws/network-hardening-policy.template.json", import.meta.url),
    "utf8",
  );
  const policy = template.replace(/<([A-Z_]+)>/g, (_, key) => {
    if (!replacements[key]) throw new Error(`Unknown policy placeholder: ${key}`);
    return replacements[key];
  });
  const parsed = JSON.parse(policy);
  if (JSON.stringify(parsed).length > 6_144) {
    throw new Error("The policy exceeds the customer-managed policy character limit.");
  }
  console.log(JSON.stringify(parsed, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[aws-network-hardening] ${error.message}`);
  process.exitCode = 1;
}
