# Self-hosted Supabase staging network

**Reserve private paths for Supabase before deploying its database or APIs.** This opt-in Terraform change prepares security groups only; it creates no compute, storage, public ingress, TLS, or paid endpoint.

```mermaid
flowchart LR
    proxy["Future private TLS proxy<br/>services-a"] -->|"TCP 8000 · proxy → API SGs"| gateway["Future Supabase APIs<br/>services-a"]
    gateway -->|"TCP 5432 · API → DB SGs"| db[("Future PostgreSQL EC2<br/>database-a")]
```

| Path            | Security groups                      | Boundary                             |
| --------------- | ------------------------------------ | ------------------------------------ |
| Proxy → gateway | New proxy egress; new API ingress    | TCP 8000, group references only      |
| APIs → Postgres | New API egress; new database ingress | TCP 5432, group references only      |
| Everything else | No new rule                          | No CIDR, SSH, public IP, or NAT path |

- `enable_self_hosted_supabase_connectivity` defaults to `false` and requires the existing private task connectivity flag. When enabled, the network plan adds **3 security groups and 4 rules**. Existing web/worker endpoint rules remain unchanged.
- A future private TLS proxy can attach the new proxy group to forward to the gateway; a Supabase API task attaches the API group; PostgreSQL attaches the database group. Web/worker need a separately reviewed HTTPS/443 path to that proxy. The current one-off launch renderer accepts exactly two task groups and cannot use this TCP/8000 path directly.
- First-AZ placement is `services-a` for APIs and `database-a` for PostgreSQL. Both subnets are private; the database route table still has no default route. This is a qualification topology, not high availability.
- The output exposes those two subnet IDs and three group IDs only. No credentials or deployment requests are produced.

**Do not enable or apply this flag yet.** The offline [temporary IAM grant](AWS-SUPABASE-NETWORK-GRANT.md) prepares a one-for-one policy attachment swap; it does not create the private TLS proxy or a browser HTTPS route. Review the full, untargeted saved Terraform plan before any apply. After apply, inspect every live rule: Terraform's standalone rule resources do not detect unrelated extra rules.

| Later batch       | Required before running Supabase in AWS                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database host     | Pinned OS/image delivery into `database-a`, private administration path, dedicated encrypted persistent storage, database-aware backup/restore, recovery target      |
| API tasks         | Mirrored pinned images, expanded private ECR/Logs/Secrets access, co-located or explicitly routed interservice topology, health checks, Auth/OAuth/email egress      |
| Storage / ingress | S3 backend and restricted access, split-horizon HTTPS hostname with private/public TLS, browser API routes but no public Studio/admin, callback and WebSocket checks |

- The current ECR endpoint policy permits only the Wallie web/worker repositories; the current S3 gateway endpoint is associated only with service route tables. The database subnet cannot use those paths as-is. The API group's only outbound rule is PostgreSQL TCP/5432, so Storage S3 and Auth email/OAuth paths need separate review before those features work.
- Supabase's [gateway defaults to HTTP on port 8000](https://supabase.com/docs/guides/self-hosting/docker#configure-supabase-urls), while production browser access requires HTTPS. The application uses one `NEXT_PUBLIC_SUPABASE_URL` for browser, server, worker, and its health check. This skeleton alone does not make the [first app tasks](AWS-APP-TASK-DEFINITIONS.md) runnable.
- Security groups have [no additional charge](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html). EC2, EBS, backups, API tasks, S3, load balancing, and any extra VPC endpoints will incur AWS charges in later batches.
- Self-hosted Supabase needs no Supabase Cloud project or billing organization; this stack remains in our AWS account. [Supabase self-hosting responsibilities](https://supabase.com/docs/guides/self-hosting).

**Offline check:** `terraform -chdir=infra/aws/staging-network fmt -check -recursive`, `init -backend=false -lockfile=readonly`, `validate`, and `test`. These mock checks do not verify live IAM or network behavior.
