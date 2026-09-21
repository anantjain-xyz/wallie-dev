const namePattern = /^[\w+=,.@-]{1,64}$/;
const sessionPattern = /^[\w+=,.@-]{2,64}$/;

function nameWithPath(value) {
  const separator = value.lastIndexOf("/");
  const path = `/${value.slice(0, separator + 1)}`;
  return (
    namePattern.test(value.slice(separator + 1)) &&
    path.length <= 512 &&
    (path === "/" || /^\/[\x21-\x7e]+\/$/.test(path))
  );
}

/** Bind refreshed credentials to the same AWS principal, allowing only role session renewal. */
export function stableAwsIdentity(identity, expectedAccount, expectedPartition) {
  if (
    typeof expectedAccount !== "string" ||
    expectedAccount.length !== 12 ||
    !/^\d{12}$/.test(expectedAccount) ||
    !["aws", "aws-cn", "aws-us-gov"].includes(expectedPartition) ||
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    identity.Account !== expectedAccount ||
    typeof identity.Arn !== "string" ||
    identity.Arn.length < 20 ||
    identity.Arn.length > 2048 ||
    /[^\x21-\x7e]/.test(identity.Arn) ||
    typeof identity.UserId !== "string" ||
    /[^\x21-\x7e]/.test(identity.UserId)
  )
    throw new Error("AWS identity is malformed or does not match the expected account/partition");

  const arn = /^arn:([^:]+):(iam|sts)::(\d{12}):(.+)$/.exec(identity.Arn);
  if (!arn || arn[1] !== expectedPartition || arn[3] !== expectedAccount)
    throw new Error("AWS identity is malformed or does not match the expected account/partition");
  const [, , service, , resource] = arn;

  // IAM IDs are stable 16–128 character identifiers. Keep the ID as well as the ARN
  // so deleting/recreating a user or role with the same name cannot match.
  // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html
  if (
    service === "iam" &&
    resource.startsWith("user/") &&
    nameWithPath(resource.slice("user/".length)) &&
    /^AIDA\w{12,124}$/.test(identity.UserId)
  )
    return JSON.stringify([identity.Arn, identity.UserId]);

  if (service === "sts" && resource.startsWith("assumed-role/")) {
    const separator = resource.lastIndexOf("/");
    const role = resource.slice("assumed-role/".length, separator);
    const session = resource.slice(separator + 1);
    const [roleId, userSession, extra] = identity.UserId.split(":");
    if (
      nameWithPath(role) &&
      sessionPattern.test(session) &&
      /^AROA\w{12,124}$/.test(roleId) &&
      userSession === session &&
      extra === undefined
    ) {
      // Preserve the complete ARN prefix, including any path; remove only its session.
      const principalArn = identity.Arn.slice(0, identity.Arn.lastIndexOf("/"));
      return JSON.stringify([principalArn, roleId]);
    }
  }

  // GetFederationToken identities have no stable role ID. Require their full identity;
  // changing the federated name is a different principal, not a role session refresh.
  if (service === "sts" && resource.startsWith("federated-user/")) {
    const name = resource.slice("federated-user/".length);
    if (/^[\w+=,.@-]{2,32}$/.test(name) && identity.UserId === `${expectedAccount}:${name}`)
      return JSON.stringify([identity.Arn, identity.UserId]);
  }
  throw new Error(
    "AWS identity must be a valid non-root IAM user, assumed role, or federated user",
  );
}
