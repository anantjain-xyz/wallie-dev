import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const inputs = {
  "account-id": ["ACCOUNT_ID", /^[0-9]{12}$/],
  region: ["REGION", /^(?!cn-)[a-z]{2}-[a-z]+-[0-9]+$/],
  "vpc-id": ["VPC_ID", /^vpc-[a-f0-9]{17}$/],
  "services-subnet-a-id": ["SERVICES_SUBNET_A_ID", /^subnet-[a-f0-9]{17}$/],
  "services-subnet-b-id": ["SERVICES_SUBNET_B_ID", /^subnet-[a-f0-9]{17}$/],
  "services-route-table-a-id": ["SERVICES_ROUTE_TABLE_A_ID", /^rtb-[a-f0-9]{17}$/],
  "services-route-table-b-id": ["SERVICES_ROUTE_TABLE_B_ID", /^rtb-[a-f0-9]{17}$/],
  "s3-prefix-list-arn": [
    "S3_PREFIX_LIST_ARN",
    /^arn:aws:ec2:[a-z]{2}-[a-z]+-[0-9]+:aws:prefix-list\/pl-(?:[a-f0-9]{8}|[a-f0-9]{17})$/,
  ],
};

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      ...Object.fromEntries(Object.keys(inputs).map((key) => [key, { type: "string" }])),
      "runtime-secrets": { type: "boolean" },
    },
  });
  if (
    positionals.length !== 0 ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length
  )
    throw new Error("Use each named argument exactly once; no positional arguments are supported");

  let template = readFileSync(
    new URL("../infra/aws/private-connectivity-policy.template.json", import.meta.url),
    "utf8",
  );
  for (const [key, [placeholder, pattern]] of Object.entries(inputs)) {
    const value = values[key];
    if (typeof value !== "string" || !pattern.test(value) || value.trim() !== value)
      throw new Error(`Missing or invalid --${key}`);
    template = template.replaceAll(`<${placeholder}>`, value);
  }
  for (const kind of ["subnet", "route-table"]) {
    if (values[`services-${kind}-a-id`] === values[`services-${kind}-b-id`])
      throw new Error(`The two services ${kind} IDs must be distinct`);
  }
  if (!values["s3-prefix-list-arn"].startsWith(`arn:aws:ec2:${values.region}:aws:prefix-list/`))
    throw new Error("The AWS-owned S3 prefix-list ARN must match --region");
  const policy = JSON.parse(template);
  if (values["runtime-secrets"]) {
    const endpoint = policy.Statement.find(
      (statement) =>
        statement.Action === "ec2:CreateVpcEndpoint" &&
        statement.Resource ===
          `arn:aws:ec2:${values.region}:${values["account-id"]}:vpc-endpoint/*`,
    );
    endpoint.Condition.StringEquals["ec2:VpceServiceName"].push(
      `com.amazonaws.${values.region}.secretsmanager`,
    );
    endpoint.Condition.StringEquals["aws:RequestTag/Name"].push("wallie-staging-runtime-secrets");
  }
  if (JSON.stringify(policy).length > 6144)
    throw new Error("Rendered policy exceeds the customer-managed policy size limit");
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(`[aws-private-connectivity] ${error.message}`);
  process.exitCode = 1;
}
