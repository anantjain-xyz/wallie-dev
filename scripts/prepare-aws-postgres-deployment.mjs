import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-postgres-deployment.mjs --policy identity-network|compute-storage --account-id <12 digits> --region <commercial AWS region> --vpc-id <vpc-id> --subnet-id <database-a-subnet-id> --database-security-group-id <db-sg-id> --ami-id <amazon-al2023-ami-id> --kms-key-arn <verified-default-ebs-key-arn> --expires-at <UTC timestamp>";

const computeStorageSids = new Set([
  "ReadEc2Inventory",
  "LaunchPinnedHostInputs",
  "LaunchNamedHost",
  "LaunchPrivateInterface",
  "LaunchEncryptedRootVolume",
  "CreateEncryptedDataVolume",
  "AttachOnlyNamedHostData",
  "ProtectNamedHostTermination",
  "TagOnlyAtCreation",
  "UseVerifiedEbsKey",
  "GrantVerifiedEbsKeyToEc2",
]);

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries(
      [
        "policy",
        "account-id",
        "region",
        "vpc-id",
        "subnet-id",
        "database-security-group-id",
        "ami-id",
        "kms-key-arn",
        "expires-at",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  const {
    policy: selectedPolicy,
    "account-id": account,
    region,
    "vpc-id": vpc,
    "subnet-id": subnet,
    "database-security-group-id": dbGroup,
    "ami-id": ami,
    "kms-key-arn": keyArn,
    "expires-at": expiresAt,
  } = values;
  if (
    positionals.length !== 0 ||
    tokens.filter((token) => token.kind === "option").length !== 9 ||
    Object.keys(values).length !== 9 ||
    Object.values(values).some((value) => value !== value.trim() || value === "") ||
    !["identity-network", "compute-storage"].includes(selectedPolicy) ||
    !/^[0-9]{12}$/.test(account ?? "") ||
    !/^(?!cn-|us-gov-|us-iso-)[a-z]{2}-[a-z]+-[0-9]+$/.test(region ?? "") ||
    !/^vpc-[a-f0-9]{17}$/.test(vpc ?? "") ||
    !/^subnet-[a-f0-9]{17}$/.test(subnet ?? "") ||
    !/^sg-[a-f0-9]{17}$/.test(dbGroup ?? "") ||
    !/^ami-[a-f0-9]{17}$/.test(ami ?? "") ||
    !new RegExp(
      `^arn:aws:kms:${region}:${account}:key/(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|mrk-[a-f0-9]{32})$`,
    ).test(keyArn ?? "") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresAt ?? "")
  ) {
    throw new Error(usage);
  }
  const expiry = Date.parse(expiresAt);
  const remaining = expiry - Date.now();
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== expiresAt.replace(/Z$/, ".000Z") ||
    remaining < 2 * 60 * 60 * 1000 ||
    remaining > 24 * 60 * 60 * 1000
  ) {
    throw new Error("--expires-at must be a real UTC time 2 to 24 hours from now");
  }

  const replacements = {
    ACCOUNT_ID: account,
    REGION: region,
    VPC_ID: vpc,
    SUBNET_ID: subnet,
    DATABASE_SECURITY_GROUP_ID: dbGroup,
    AMI_ID: ami,
    KMS_KEY_ARN: keyArn,
  };
  const template = readFileSync(
    new URL("../infra/aws/postgres-deployment-policy.template.json", import.meta.url),
    "utf8",
  );
  const rendered = template.replace(/<([A-Z_]+)>/g, (_, key) => {
    if (!Object.hasOwn(replacements, key)) throw new Error(`Unknown policy placeholder: ${key}`);
    return replacements[key];
  });
  const policy = JSON.parse(rendered);
  policy.Statement = policy.Statement.filter(
    (statement) => computeStorageSids.has(statement.Sid) === (selectedPolicy === "compute-storage"),
  );
  for (const statement of policy.Statement) {
    delete statement.Sid;
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const condition = (statement.Condition ??= {});
    condition.StringEquals = {
      ...(condition.StringEquals ?? {}),
      "aws:PrincipalAccount": account,
      ...(actions.every((action) => action.startsWith("iam:"))
        ? {}
        : { "aws:RequestedRegion": region }),
    };
    condition.DateLessThan = { "aws:CurrentTime": expiresAt };
  }
  if (JSON.stringify(policy).length > 6_144)
    throw new Error(
      `Rendered policy has ${JSON.stringify(policy).length} characters, exceeding IAM's 6,144-character managed-policy limit`,
    );
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(`[aws-postgres-deployment] ${error.message}`);
  process.exitCode = 1;
}
