# Temporary Supabase network grant

**Prepare an offline IAM grant for the three security groups and four rules from [the default-off network slice](AWS-SUPABASE-NETWORK.md).** This renderer makes no AWS calls. The proxy SG names must match the merged runtime contract before live use; do not render or apply against a `supabase_client` configuration.

| Boundary     | Grant                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Existing VPC | Exact VPC ARN, owned by `WallieStack=wallie-staging-network`                                                           |
| New groups   | `Name` tag limited to three reviewed values with `Component=self-hosted-supabase`                                      |
| New rules    | `Name` tag limited to four reviewed values on named, owned groups in that VPC                                          |
| Mutations    | Create groups/rules, remove the groups' default egress; creation-time tags only                                        |
| Lifetime     | IAM `aws:CurrentTime` expires the grant at the required UTC deadline, 2–24 hours after rendering                       |
| Excluded     | IAM writes, endpoint changes, CIDRs, routes, compute, storage, deletion, existing application/endpoint group mutations |

IAM does not constrain actual EC2 `GroupName`, resource count, or a rule's TCP port, protocol, and peer group with supported EC2 condition keys. The **untargeted saved Terraform plan** and complete live inventory must enforce exactly 3 groups/4 rules and their tuples. The grant does not enable a Supabase task, database, or browser route. AWS requires rule `TagSpecifications` to evaluate rule-resource conditions; pinned provider 6.65.0 sends them for both [ingress](https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v6.65.0/internal/service/ec2/vpc_security_group_ingress_rule.go) and [egress](https://raw.githubusercontent.com/hashicorp/terraform-provider-aws/v6.65.0/internal/service/ec2/vpc_security_group_egress_rule.go). The `ec2:CreateTags` statements use AWS's [creation-time `ec2:CreateAction` pattern](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/supported-iam-actions-tagging.html), scoped to the two authorization actions. [EC2 action/condition reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html)

## Offline preparation

1. After the runtime-contract PR merges, refresh main and confirm Terraform uses the proxy SG and rule names. At the later apply gate, confirm the staging VPC ID and `WallieStack` tag from AWS; confirm no group with any reviewed actual name **or** Name tag already exists. Choose a UTC expiry 2–24 hours ahead. Render and review the policy:

   ```sh
   umask 077
   mkdir -p .wallie/aws
   node scripts/prepare-aws-supabase-connectivity.mjs \
     --account-id 111614490109 --region us-west-2 \
     --vpc-id '<verified-staging-vpc-id>' \
     --expires-at '<YYYY-MM-DDTHH:MM:SSZ>' \
     > .wallie/aws/supabase-connectivity-policy.json
   ```

2. The administrator creates customer-managed `WallieStagingSupabaseConnectivity` from the reviewed JSON, **without attaching it yet**. Confirm its default policy document, UTC expiry, and that no identity is attached. The script does not call AWS. Re-render and update the unattached policy if preparation takes too long; never attach an expired version.

## Temporary attachment swap at the later apply gate

`wallie-local` already has **10/10** managed policies; `WallieStagingPrivateConnectivity` is near its 6,144-character policy limit. Do not append to it or attempt an eleventh attachment.

1. Record all ten attached policy ARNs and default version IDs. Record the exact `WallieStagingRegistry` ARN, default policy JSON, and every attached identity. Stop if the identity inventory differs from the reviewed state or registry provisioning is active.
2. The administrator detaches **only `WallieStagingRegistry` from `wallie-local`**, then attaches `WallieStagingSupabaseConnectivity`. Verify exactly ten attachments, only that one-for-one difference, and the expected new policy default. If attachment fails, immediately restore the exact Registry ARN and stop. Keep network, private connectivity, hardening, state, and sign-in grants attached.
3. Only after a separate browser HTTPS routing decision and a reviewed, untargeted saved network plan: require **exactly 3 SG and 4 rule additions; 0 updates/deletes**. Require actual SG names, Name tags, and four rule names to match the policy; require SG peers only, TCP 8000 for proxy/API and TCP 5432 for API/database, or the separately reviewed revised port contract. No CIDR rule, broad egress, endpoint edit, NAT, route, compute, or storage addition. Confirm at least 90 minutes remain before IAM expiry; do not apply an outdated plan after a routing change.
4. After any reviewed apply, enumerate all groups with the Supabase component and reviewed Name tags in the VPC; inspect actual group names and **every** rule, including unmodeled extras. Require exactly the three planned groups/four planned rules, reviewed peers/directions/ports, no default egress, and a zero-diff network plan. Stop for investigation if the readback differs.
5. The administrator detaches `WallieStagingSupabaseConnectivity`, reattaches the **exact recorded** `WallieStagingRegistry` ARN, and verifies all ten original attachments and default versions. Leave the temporary policy unattached; delete it when no further network apply is planned.

If the deadline expires or an apply fails, immediately inspect Terraform state and **all new groups' live rules**. AWS initially gives a new group allow-all egress until Terraform revokes it; block any workload attachment to a group with unexpected egress. Recover a partial apply only through a separately reviewed plan. Do not blindly retry or extend an attached grant without a new review.

This is an attachment procedure, not an automated IAM or Terraform mutation. A newly created managed policy affects every identity attached to it; confirm attachment scope before and after the swap. [IAM attachment quota](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)
