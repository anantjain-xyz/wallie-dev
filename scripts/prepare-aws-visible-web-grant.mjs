import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export function visibleWebGrant(kind, { account, region, expiresAt }, now = Date.now()) {
  check(
    account === "111614490109" && region === "us-west-2",
    "Expected the reviewed staging account and region",
  );
  const deadline = Date.parse(expiresAt);
  check(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(expiresAt ?? "") &&
      Number.isFinite(deadline) &&
      deadline > now + 5 * 60_000 &&
      deadline <= now + 24 * 60 * 60_000,
    "Expiry must be five minutes to 24 hours ahead in whole-second UTC",
  );
  const condition = {
    StringEquals: { "aws:PrincipalAccount": account, "aws:RequestedRegion": region },
    DateLessThan: { "aws:CurrentTime": expiresAt },
  };
  const createCondition = {
    ...condition,
    StringEquals: {
      ...condition.StringEquals,
      "aws:RequestTag/WallieStack": "wallie-staging-application",
    },
  };
  const ownedCondition = {
    ...condition,
    StringEquals: {
      ...condition.StringEquals,
      "aws:ResourceTag/WallieStack": "wallie-staging-application",
    },
  };
  const sgNames = ["wallie-staging-web-alb", "wallie-staging-web-ingress"];
  const ruleNames = [
    "wallie-staging-web-alb-https",
    "wallie-staging-web-alb-to-task",
    "wallie-staging-web-task-from-alb",
  ];
  const sgCreate = {
    ...createCondition,
    StringEquals: { ...createCondition.StringEquals, "aws:RequestTag/Name": sgNames },
  };
  const sgOwned = {
    ...ownedCondition,
    StringEquals: { ...ownedCondition.StringEquals, "aws:ResourceTag/Name": sgNames },
  };
  const ruleCreate = {
    ...createCondition,
    StringEquals: { ...createCondition.StringEquals, "aws:RequestTag/Name": ruleNames },
  };
  const ruleOwned = {
    ...ownedCondition,
    StringEquals: { ...ownedCondition.StringEquals, "aws:ResourceTag/Name": ruleNames },
  };
  const sg = `arn:aws:ec2:${region}:${account}:security-group/*`;
  const sgRule = `arn:aws:ec2:${region}:${account}:security-group-rule/*`;
  const stagingVpc = `arn:aws:ec2:${region}:${account}:vpc/vpc-0c39dfdf1f090e4ff`;
  const alb = `arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/app/wallie-staging-web/*`;
  const tg = `arn:aws:elasticloadbalancing:${region}:${account}:targetgroup/wallie-staging-web/*`;
  const listener = `arn:aws:elasticloadbalancing:${region}:${account}:listener/app/wallie-staging-web/*/*`;
  const certificate = `arn:aws:acm:${region}:${account}:certificate/*`;
  let statements;
  if (kind === "infrastructure") {
    statements = [
      {
        Sid: "Read",
        Effect: "Allow",
        Action: [
          "ec2:DescribeVpcs",
          "ec2:DescribeSubnets",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeSecurityGroupRules",
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeLoadBalancerAttributes",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetGroupAttributes",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeTags",
        ],
        Resource: "*",
        Condition: condition,
      },
      {
        Sid: "CreateSG",
        Effect: "Allow",
        Action: "ec2:CreateSecurityGroup",
        Resource: sg,
        Condition: sgCreate,
      },
      {
        Sid: "InVpc",
        Effect: "Allow",
        Action: "ec2:CreateSecurityGroup",
        Resource: stagingVpc,
        Condition: condition,
      },
      {
        Sid: "TagSG",
        Effect: "Allow",
        Action: "ec2:CreateTags",
        Resource: sg,
        Condition: {
          ...sgCreate,
          StringEquals: { ...sgCreate.StringEquals, "ec2:CreateAction": "CreateSecurityGroup" },
        },
      },
      {
        Sid: "UpdateSG",
        Effect: "Allow",
        Action: [
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:AuthorizeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress",
          "ec2:RevokeSecurityGroupEgress",
        ],
        Resource: sg,
        Condition: sgOwned,
      },
      {
        Sid: "CreateSGRule",
        Effect: "Allow",
        Action: ["ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress"],
        Resource: sgRule,
        Condition: ruleCreate,
      },
      {
        Sid: "TagSGRule",
        Effect: "Allow",
        Action: "ec2:CreateTags",
        Resource: sgRule,
        Condition: {
          ...ruleCreate,
          StringEquals: {
            ...ruleCreate.StringEquals,
            "ec2:CreateAction": ["AuthorizeSecurityGroupIngress", "AuthorizeSecurityGroupEgress"],
          },
        },
      },
      {
        Sid: "RevokeSGRule",
        Effect: "Allow",
        Action: ["ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress"],
        Resource: sgRule,
        Condition: ruleOwned,
      },
    ];
  } else if (kind === "service") {
    statements = [
      {
        Sid: "ReadCertificates",
        Effect: "Allow",
        Action: [
          "acm:ListCertificates",
          "acm:DescribeCertificate",
          "acm:GetCertificate",
          "acm:ListTagsForCertificate",
        ],
        Resource: "*",
        Condition: condition,
      },
      {
        Sid: "ReqCert",
        Effect: "Allow",
        Action: "acm:RequestCertificate",
        Resource: "*",
        Condition: {
          ...createCondition,
          StringEquals: { ...createCondition.StringEquals, "acm:ValidationMethod": "DNS" },
          "ForAllValues:StringEquals": { "acm:DomainNames": ["aws-staging.wallie.dev"] },
        },
      },
      {
        Sid: "TagCert",
        Effect: "Allow",
        Action: "acm:AddTagsToCertificate",
        Resource: certificate,
        Condition: createCondition,
      },
      {
        Sid: "CreateLB",
        Effect: "Allow",
        Action: "elasticloadbalancing:CreateLoadBalancer",
        Resource: alb,
        Condition: createCondition,
      },
      {
        Sid: "CreateTG",
        Effect: "Allow",
        Action: "elasticloadbalancing:CreateTargetGroup",
        Resource: tg,
        Condition: createCondition,
      },
      {
        Sid: "CreateL",
        Effect: "Allow",
        Action: "elasticloadbalancing:CreateListener",
        Resource: alb,
        Condition: {
          ...createCondition,
          StringEquals: {
            ...createCondition.StringEquals,
            "elasticloadbalancing:ListenerProtocol": "HTTPS",
          },
        },
      },
      {
        Sid: "TagLB",
        Effect: "Allow",
        Action: "elasticloadbalancing:AddTags",
        Resource: [alb, tg, listener],
        Condition: createCondition,
      },
      {
        Sid: "UpdateLB",
        Effect: "Allow",
        Action: [
          "elasticloadbalancing:ModifyLoadBalancerAttributes",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
          "elasticloadbalancing:ModifyListener",
        ],
        Resource: [alb, tg, listener],
        Condition: ownedCondition,
      },
      {
        Sid: "ReadWebServiceMetadata",
        Effect: "Allow",
        Action: [
          "ecs:DescribeClusters",
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:ListTagsForResource",
          "ecs:ListTasks",
          "ecs:DescribeTasks",
        ],
        Resource: "*",
        Condition: condition,
      },
      {
        Sid: "CreateTaggedWebService",
        Effect: "Allow",
        Action: "ecs:CreateService",
        Resource: `arn:aws:ecs:${region}:${account}:service/wallie-staging/wallie-staging-web`,
        Condition: {
          ...createCondition,
          ArnEquals: { "ecs:cluster": `arn:aws:ecs:${region}:${account}:cluster/wallie-staging` },
        },
      },
      {
        Sid: "UpdateOwnedWebService",
        Effect: "Allow",
        Action: "ecs:UpdateService",
        Resource: `arn:aws:ecs:${region}:${account}:service/wallie-staging/wallie-staging-web`,
        Condition: ownedCondition,
      },
      {
        Sid: "TagNewWebService",
        Effect: "Allow",
        Action: "ecs:TagResource",
        Resource: `arn:aws:ecs:${region}:${account}:service/wallie-staging/wallie-staging-web`,
        Condition: {
          ...createCondition,
          StringEquals: { ...createCondition.StringEquals, "ecs:CreateAction": "CreateService" },
        },
      },
      {
        Sid: "PassOnlyWebExecutionRole",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: `arn:aws:iam::${account}:role/wallie-staging-web-execution`,
        Condition: {
          StringEquals: {
            "aws:PrincipalAccount": account,
            "iam:PassedToService": "ecs-tasks.amazonaws.com",
          },
          DateLessThan: { "aws:CurrentTime": expiresAt },
        },
      },
    ];
  } else throw new Error("Expected infrastructure or service policy");
  const policy = { Version: "2012-10-17", Statement: statements };
  check(JSON.stringify(policy).length <= 6144, "Grant exceeds IAM managed-policy size limit");
  return policy;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals, tokens } = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: Object.fromEntries(
        ["account", "region", "expires-at"].map((name) => [name, { type: "string" }]),
      ),
    });
    check(
      positionals.length === 1 && tokens.length === 3 && Object.keys(values).length === 3,
      "Expected kind and three exact arguments",
    );
    console.log(
      JSON.stringify(
        visibleWebGrant(positionals[0], {
          account: values.account,
          region: values.region,
          expiresAt: values["expires-at"],
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`[aws-visible-web-grant] ${error.message}`);
    process.exitCode = 1;
  }
}
