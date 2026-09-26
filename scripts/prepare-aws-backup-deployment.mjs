import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const required = ["account-id", "region", "expires-at"];

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries(required.map((name) => [name, { type: "string" }])),
  });
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
  if (!/^(?!cn-|us-gov-|us-iso-)[a-z]{2}-[a-z]+-[0-9]+$/.test(region) || region === "us-east-1") {
    throw new Error("Use a commercial --region other than us-east-1");
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

  const bucket = `wallie-staging-postgres-backups-${account}-${region}`;
  const template = readFileSync(
    new URL("../infra/aws/backup-deployment-policy.template.json", import.meta.url),
    "utf8",
  );
  const policy = JSON.parse(
    template
      .replaceAll("<ACCOUNT_ID>", account)
      .replaceAll("<REGION>", region)
      .replaceAll("<BUCKET_NAME>", bucket),
  );
  for (const statement of policy.Statement) {
    statement.Condition.DateLessThan = { "aws:CurrentTime": expiresAt };
  }
  if (JSON.stringify(policy).length > 6_144)
    throw new Error("Rendered policy exceeds IAM's 6,144-character managed-policy limit");
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(`[aws-backup-deployment] ${error.message}`);
  process.exitCode = 1;
}
