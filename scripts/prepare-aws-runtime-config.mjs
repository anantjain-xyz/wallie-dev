import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-runtime-config.mjs --account-id <12 digits> --region <commercial AWS region> --web-secret-arn <full own ARN> --worker-secret-arn <full own ARN> --web-version-id <version ID> --worker-version-id <version ID>";

const publicEnvironmentNames = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
];
const plainEnvironmentNames = ["WALLIE_DEPLOY_ENV"];
const secretEnvironmentNames = ["SUPABASE_SECRET_KEY", "WALLIE_ENCRYPTION_KEY"];

function prepare(values) {
  const account = values["account-id"];
  const region = values.region;
  if (!/^\d{12}$/.test(account ?? "") || !/^(?!cn-)[a-z]{2}-[a-z]+-\d+$/.test(region ?? ""))
    throw new Error(usage);

  const components = {};
  for (const component of ["web", "worker"]) {
    const secretArn = values[`${component}-secret-arn`];
    const versionId = values[`${component}-version-id`];
    const ownSecretArn = new RegExp(
      `^arn:aws:secretsmanager:${region}:${account}:secret:/wallie/staging/${component}/runtime-[A-Za-z0-9]{6}$`,
    );
    if (!ownSecretArn.test(secretArn ?? ""))
      throw new Error(`Expected the full owned ${component} runtime secret ARN`);
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(versionId ?? ""))
      throw new Error(`Expected a 32–64 character ${component} Secrets Manager version ID`);

    components[component] = {
      secretArn,
      versionId,
      secrets: secretEnvironmentNames.map((name) => ({
        name,
        valueFrom: `${secretArn}:${name}::${versionId}`,
      })),
    };
  }

  return {
    schemaVersion: 1,
    account,
    region,
    deployable: false,
    publicEnvironmentNames,
    plainEnvironmentNames,
    components,
  };
}

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries(
      [
        "account-id",
        "region",
        "web-secret-arn",
        "worker-secret-arn",
        "web-version-id",
        "worker-version-id",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  if (
    positionals.length !== 0 ||
    tokens.filter((token) => token.kind === "option").length !== 6 ||
    Object.keys(values).length !== 6 ||
    Object.values(values).some((value) => value === "" || value !== value.trim())
  )
    throw new Error(usage);
  console.log(JSON.stringify(prepare(values), null, 2));
} catch (error) {
  console.error(
    `[aws-runtime-config] ${error.message.startsWith("Expected") ? error.message : usage}`,
  );
  process.exitCode = 1;
}
