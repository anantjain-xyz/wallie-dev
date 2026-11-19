import Link from "next/link";
import type { ReactNode } from "react";

import type { FactoryAuditSource } from "@/lib/factories/audit-contracts";
import { workspaceGovernancePath } from "@/lib/routes";

const sourceQueryKeys = {
  principal: "principal",
  grant: "grant",
  actor: "actor",
  binding: "binding",
  "mcp-binding": "mcpBinding",
  event: "event",
} as const satisfies Record<FactoryAuditSource["kind"], string>;

export function governanceSourceQuery(source: FactoryAuditSource | undefined) {
  return source ? { [sourceQueryKeys[source.kind]]: source.id } : {};
}

export function GovernanceResourceLink({
  children,
  factoryId,
  source,
  workspaceSlug,
}: {
  children: ReactNode;
  factoryId: string;
  source: FactoryAuditSource;
  workspaceSlug: string;
}) {
  return (
    <Link
      className="font-medium text-foreground underline decoration-border underline-offset-4 hover:text-accent hover:decoration-current [overflow-wrap:anywhere]"
      href={workspaceGovernancePath(workspaceSlug, {
        factory: factoryId,
        ...governanceSourceQuery(source),
      })}
    >
      {children}
    </Link>
  );
}

const auditTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function GovernanceTime({ value }: { value: string }) {
  return <time dateTime={value}>{auditTime.format(new Date(value))} UTC</time>;
}
