import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/prepare-aws-network.mjs", import.meta.url));
const account = "123456789012";
const region = "us-west-2";
const marker = "wallie-staging-network";
const common = ["--account-id", account, "--region", region];
const zones = ["--availability-zones", "us-west-2a,us-west-2b"];
const creationActions = ["CreateVpc", "CreateSubnet", "CreateRouteTable", "CreateInternetGateway"];
const resourceTypes = [
  "vpc",
  "subnet",
  "route-table",
  "internet-gateway",
  "elastic-ip",
  "natgateway",
];
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string | string[]>>;
};

function render(command: string, args = common) {
  return spawnSync(process.execPath, [script, command, ...args], {
    encoding: "utf8",
    timeout: 5_000,
    env: { NODE_ENV: "test", PATH: "" },
  });
}

function statements() {
  const result = render("policy");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout).Statement as Statement[];
}

describe("AWS network preparation", () => {
  it.each([
    [region, "aws"],
    ["us-gov-west-1", "aws-us-gov"],
    ["cn-north-1", "aws-cn"],
  ])("renders a standalone network policy offline for %s", (awsRegion, partition) => {
    const result = render("policy", ["--account-id", account, "--region", awsRegion]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/<[A-Z_]+>|access_key|secret_key|token|profile/);
    const policy = JSON.parse(result.stdout);
    expect(policy.Version).toBe("2012-10-17");
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6_144);
    for (const statement of policy.Statement as Statement[]) {
      expect(statement.Effect).toBe("Allow");
      // New EIP/NAT grants are account/region scoped by their resource ARNs;
      // omitting duplicate conditions keeps the managed policy under 6,144.
      if (
        !array(statement.Resource).some(
          (resource) => resource.includes(":elastic-ip/") || resource.includes(":natgateway/"),
        )
      ) {
        expect(statement.Condition.StringEquals).toMatchObject({
          "aws:PrincipalAccount": account,
          "aws:RequestedRegion": awsRegion,
        });
      }
      for (const action of array(statement.Action)) {
        expect(action).toMatch(/^ec2:[A-Za-z]+$/);
      }
      for (const resource of array(statement.Resource)) {
        if (resource === "*") {
          expect(array(statement.Action).every((action) => action.startsWith("ec2:Describe"))).toBe(
            true,
          );
        } else {
          expect(
            resourceTypes.map((type) => `arn:${partition}:ec2:${awsRegion}:${account}:${type}/*`),
          ).toContain(resource);
        }
      }
    }
  });

  it.each([undefined, "10.255.0.0/16", "172.16.0.0/16", "172.31.0.0/16", "192.168.0.0/16"])(
    "renders explicit AZs with private CIDR %s and no credentials or backend settings",
    (cidr) => {
      const result = render("variables", [...common, ...zones, ...(cidr ? ["--cidr", cidr] : [])]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        aws_account_id: account,
        aws_region: region,
        availability_zones: ["us-west-2a", "us-west-2b"],
        vpc_cidr: cidr ?? "10.42.0.0/16",
      });
    },
  );

  it.each([
    ["apply", common],
    ["policy", []],
    ["policy", ["--account-id", "123", "--region", region]],
    ["policy", ["--account-id", account, "--region", 'us-west-2"\nprofile="root']],
    ["policy", ["--account-id", account, "--region", "us-iso-east-1"]],
    ["policy", [...common, "--region", region]],
    ["policy", [...common, "--profile", "root"]],
    ["policy", [...common, "extra"]],
    ["policy", [...common, ...zones]],
    ["policy", [...common, "--cidr", ""]],
    ["policy", [...common, "--availability-zones", ""]],
    ["variables", common],
    ["variables", [...common, "--availability-zones", "us-west-2a,us-west-2a"]],
    ["variables", [...common, "--availability-zones", "us-west-2a,us-east-1b"]],
    ["variables", [...common, "--availability-zones", "us-west-2a,us-west-2b,us-west-2c"]],
    ["variables", [...common, "--availability-zones", "us-west-2-lax-1a,us-west-2b"]],
    ...[
      "8.8.0.0/16",
      "172.15.0.0/16",
      "172.32.0.0/16",
      "10.256.0.0/16",
      "10.42.1.0/16",
      "10.42.0.0/24",
      "010.42.0.0/16",
    ].map((cidr) => ["variables", [...common, ...zones, "--cidr", cidr]]),
  ] as [string, string[]][])("rejects invalid input: %s %j", (command, args) => {
    const result = render(command, args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-network]");
  });
});

// Structural regression guards for this policy, not an AWS authorization simulator.
describe("network policy ownership", () => {
  it("reads EIP address attributes for Terraform's NAT/EIP refresh only in the reviewed account and region", () => {
    const inventory = statements().find((statement) =>
      array(statement.Action).includes("ec2:DescribeAddressesAttribute"),
    );
    expect(inventory).toMatchObject({
      Resource: "*",
      Condition: {
        StringEquals: {
          "aws:PrincipalAccount": account,
          "aws:RequestedRegion": region,
        },
      },
    });
    expect(array(inventory!.Action)).toContain("ec2:DescribeAddresses");
  });

  it("separates tagged resource creation from authorization of the existing parent VPC", () => {
    const grants = statements();
    for (const [action, type] of creationActions.map((action, index) => [
      action,
      resourceTypes[index],
    ])) {
      const matching = grants.filter((statement) =>
        array(statement.Action).includes(`ec2:${action}`),
      );
      expect(matching.length).toBeGreaterThan(0);
      for (const statement of matching) {
        for (const resource of array(statement.Resource)) {
          if (
            resource.endsWith(":vpc/*") &&
            ["CreateSubnet", "CreateRouteTable"].includes(action)
          ) {
            expect(statement.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(marker);
          } else if (resource.endsWith(`:${type}/*`)) {
            expect(statement.Condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
            expect(statement.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toContain(
              "WallieStack",
            );
          }
        }
      }
    }
  });

  it("requires ownership for every existing-resource mutation and both sides of associations", () => {
    for (const statement of statements()) {
      const mutations = array(statement.Action).filter(
        (action) =>
          ![
            ...creationActions.map((name) => `ec2:${name}`),
            "ec2:AllocateAddress",
            "ec2:CreateNatGateway",
            "ec2:CreateTags",
          ].includes(action) && !action.startsWith("ec2:Describe"),
      );
      if (mutations.length > 0) {
        expect(statement.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(marker);
      }
    }
  });

  it("permits initial tagging only during creation and cannot adopt or relabel existing resources", () => {
    for (const statement of statements().filter((s) =>
      array(s.Action).includes("ec2:CreateTags"),
    )) {
      const condition = statement.Condition;
      if (condition.StringEquals["aws:ResourceTag/WallieStack"] === marker) {
        expect(condition.StringEqualsIfExists["aws:RequestTag/WallieStack"]).toBe(marker);
      } else {
        expect(array(condition.StringEquals["ec2:CreateAction"]).sort()).toEqual(
          (array(condition.StringEquals["ec2:CreateAction"]).includes("AllocateAddress")
            ? ["AllocateAddress", "CreateNatGateway"]
            : creationActions
          ).sort(),
        );
        expect(condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
      }
      expect(condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toContain("WallieStack");
    }
  });

  it("cannot remove the ownership marker, including through an omitted DeleteTags tag list", () => {
    const grants = statements().filter((s) => array(s.Action).includes("ec2:DeleteTags"));
    expect(grants.length).toBeGreaterThan(0);
    for (const { Condition: condition } of grants) {
      expect(condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(marker);
      expect(condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
        "Project",
        "Environment",
        "ManagedBy",
        "Component",
        "Name",
        "Tier",
      ]);
      expect(condition.Null["aws:TagKeys"]).toBe("false");
    }
  });

  it("limits NAT creation to tagged EIP, NAT, subnet, and VPC resources", () => {
    const grants = statements();
    const createNat = grants.filter((s) => array(s.Action).includes("ec2:CreateNatGateway"));
    expect(createNat).toHaveLength(2);
    const requested = createNat.find((s) =>
      array(s.Resource).some((r) => r.includes(":natgateway/")),
    )!;
    expect(requested.Condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
    const parents = createNat.find((s) => array(s.Resource).some((r) => r.includes(":subnet/")))!;
    expect(array(parents.Resource).sort()).toEqual(
      ["elastic-ip", "subnet", "vpc"]
        .map((type) => `arn:aws:ec2:${region}:${account}:${type}/*`)
        .sort(),
    );
    expect(parents.Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(marker);
    const allocate = grants.find((s) => array(s.Action).includes("ec2:AllocateAddress"))!;
    expect(allocate.Resource).toBe(`arn:aws:ec2:${region}:${account}:elastic-ip/*`);
    expect(allocate.Condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(marker);
    const tag = grants.find(
      (s) =>
        array(s.Action).includes("ec2:CreateTags") &&
        array(s.Resource).some((r) => r.includes(":natgateway/")),
    )!;
    expect(tag.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).toEqual([
      "WallieStack",
      "Project",
      "Environment",
      "ManagedBy",
      "Component",
      "Name",
    ]);
    expect(grants.flatMap((s) => array(s.Action))).not.toContain("ec2:DeleteNatGateway");
    expect(grants.flatMap((s) => array(s.Action))).not.toContain("ec2:ReleaseAddress");
  });
});
