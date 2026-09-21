import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/inspect-aws-staging.mjs policy|inspect --account-id <12 digits> --region <region> [--profile <profile>] [--runner-instance-type m7i.large] [--db-instance-class db.t4g.medium]";

function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      "account-id": { type: "string" },
      region: { type: "string" },
      profile: { type: "string" },
      "runner-instance-type": { type: "string" },
      "db-instance-class": { type: "string" },
    },
  });
  const [command] = positionals;
  const accountId = values["account-id"];
  const region = values.region;
  const profile = values.profile;
  const runnerInstanceType = values["runner-instance-type"] ?? "m7i.large";
  const dbInstanceClass = values["db-instance-class"] ?? "db.t4g.medium";
  if (
    positionals.length !== 1 ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length ||
    !["policy", "inspect"].includes(command) ||
    !/^\d{12}$/.test(accountId ?? "") ||
    !/^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/.test(region ?? "") ||
    (command === "inspect" && !/^[\w][\w.-]{0,127}$/.test(profile ?? "")) ||
    !/^[a-z][a-z\d-]*\.[a-z\d-]+$/.test(runnerInstanceType) ||
    !/^db\.[a-z][a-z\d-]*\.[a-z\d]+$/.test(dbInstanceClass) ||
    (command === "policy" &&
      (profile || values["runner-instance-type"] || values["db-instance-class"]))
  ) {
    throw new Error(usage);
  }

  if (command === "policy") {
    const partition = region.startsWith("cn-")
      ? "aws-cn"
      : region.startsWith("us-gov-")
        ? "aws-us-gov"
        : "aws";
    const template = readFileSync(
      new URL("../infra/aws/discovery-policy.template.json", import.meta.url),
      "utf8",
    );
    const policy = JSON.parse(
      template
        .replaceAll("<ACCOUNT_ID>", accountId)
        .replaceAll("<REGION>", region)
        .replaceAll("<PARTITION>", partition),
    );
    console.log(JSON.stringify(policy, null, 2));
    return;
  }

  function aws(service, operation, args = []) {
    let output;
    try {
      output = execFileSync(
        "aws",
        [
          service,
          operation,
          ...args,
          "--profile",
          profile,
          "--region",
          region,
          "--output",
          "json",
          "--no-cli-pager",
          "--no-cli-auto-prompt",
          "--cli-connect-timeout",
          "15",
          "--cli-read-timeout",
          "30",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
        },
      );
    } catch (error) {
      // Avoid dumping CLI debug output or credential-provider output into reports/logs.
      const code = String(error.stderr ?? "").match(/\(([\w.-]+)\) when calling/)?.[1];
      const reason = code ?? error.code ?? `exit ${error.status ?? "unknown"}`;
      throw new Error(
        `${service} ${operation} failed (${reason}). Check AWS CLI installation, profile login, and the discovery policy. No report was produced.`,
      );
    }
    try {
      return JSON.parse(output);
    } catch {
      throw new Error(`${service} ${operation} returned invalid JSON. No report was produced.`);
    }
  }

  function list(service, operation, args) {
    const result = aws(service, operation, args);
    if (!Array.isArray(result)) {
      throw new Error(
        `${service} ${operation} returned an unexpected shape. No report was produced.`,
      );
    }
    return result;
  }

  const identity = aws("sts", "get-caller-identity");
  if (identity?.Account !== accountId) {
    throw new Error("AWS account does not match --account-id; inventory was not attempted.");
  }
  if (typeof identity.Arn !== "string" || !identity.Arn || identity.Arn.endsWith(":root")) {
    throw new Error("Use a non-root AWS identity; inventory was not attempted.");
  }

  const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
  const dbSection = config.split(/^\[db\][ \t]*\r?$/m)[1]?.split(/^\[/m)[0];
  const major = dbSection?.match(/^major_version\s*=\s*(\d+)\s*(?:#.*)?$/m)?.[1];
  if (!major) throw new Error("Cannot read PostgreSQL major_version from supabase/config.toml.");

  const report = {
    schemaVersion: 1,
    purpose: "discovery-only",
    collectedAt: new Date().toISOString(),
    region,
    postgresMajor: Number(major),
    candidates: { runnerInstanceType, dbInstanceClass },
    limitations: [
      "Catalog metadata does not establish Supabase or sandbox compatibility.",
      "Offerings do not establish launch capacity; the quota is a limit, not remaining capacity.",
      "Empty results and missing fields are unknown or unavailable, never qualification passes.",
    ],
    vpcs: list("ec2", "describe-vpcs", [
      "--query",
      "Vpcs[].{id:VpcId,isDefault:IsDefault,state:State,ipv4:CidrBlockAssociationSet[].{cidr:CidrBlock,state:CidrBlockState.State},ipv6:Ipv6CidrBlockAssociationSet[].{cidr:Ipv6CidrBlock,state:Ipv6CidrBlockState.State}}",
    ]),
    availabilityZones: list("ec2", "describe-availability-zones", [
      "--filters",
      "Name=zone-type,Values=availability-zone",
      "Name=state,Values=available",
      "--query",
      "AvailabilityZones[].{name:ZoneName,id:ZoneId,state:State,optInStatus:OptInStatus}",
    ]),
    postgresVersions: list("rds", "describe-db-engine-versions", [
      "--engine",
      "postgres",
      "--query",
      `DBEngineVersions[?starts_with(EngineVersion, '${major}.') && Status=='available'].{version:EngineVersion,parameterGroupFamily:DBParameterGroupFamily,status:Status}`,
    ]),
    databaseOptions: list("rds", "describe-orderable-db-instance-options", [
      "--engine",
      "postgres",
      "--db-instance-class",
      dbInstanceClass,
      "--vpc",
      "--query",
      `OrderableDBInstanceOptions[?starts_with(EngineVersion, '${major}.')].{version:EngineVersion,class:DBInstanceClass,availabilityZones:AvailabilityZones[].Name,multiAZ:MultiAZCapable,encryption:SupportsStorageEncryption,storageType:StorageType,minStorageGiB:MinStorageSize,maxStorageGiB:MaxStorageSize}`,
    ]),
    runnerTypes: list("ec2", "describe-instance-types", [
      "--instance-types",
      runnerInstanceType,
      "--query",
      "InstanceTypes[].{type:InstanceType,architectures:ProcessorInfo.SupportedArchitectures,features:ProcessorInfo.SupportedFeatures,vcpus:VCpuInfo.DefaultVCpus,memoryMiB:MemoryInfo.SizeInMiB,bareMetal:BareMetal}",
    ]),
    runnerOfferings: list("ec2", "describe-instance-type-offerings", [
      "--location-type",
      "availability-zone",
      "--filters",
      `Name=instance-type,Values=${runnerInstanceType}`,
      "--query",
      "InstanceTypeOfferings[].{type:InstanceType,availabilityZone:Location}",
    ]),
    standardOnDemandVcpuQuota: aws("service-quotas", "get-service-quota", [
      "--service-code",
      "ec2",
      "--quota-code",
      "L-1216C47A",
      "--query",
      "Quota.{code:QuotaCode,name:QuotaName,value:Value,unit:Unit,adjustable:Adjustable}",
    ]),
  };
  const quota = report.standardOnDemandVcpuQuota;
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
    throw new Error("get-service-quota returned an unexpected shape. No report was produced.");
  }
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[aws-discovery] ${error.message}`);
  process.exitCode = 1;
}
