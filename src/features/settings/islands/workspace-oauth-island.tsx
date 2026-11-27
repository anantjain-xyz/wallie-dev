"use client";

import { lazy, Suspense, type ComponentProps } from "react";

const RegisterOAuthClient = lazy(() =>
  import("@/features/factory-governance/governance-oauth-actions").then((module) => ({
    default: module.RegisterOAuthClient,
  })),
);
const RevokeOAuthAccess = lazy(() =>
  import("@/features/factory-governance/governance-oauth-actions").then((module) => ({
    default: module.RevokeOAuthAccess,
  })),
);

export function RegisterWorkspaceOAuthClient(props: ComponentProps<typeof RegisterOAuthClient>) {
  return (
    <Suspense fallback={<p className="type-secondary text-muted">Loading registration…</p>}>
      <RegisterOAuthClient {...props} />
    </Suspense>
  );
}

export function RevokeWorkspaceOAuthAccess(props: ComponentProps<typeof RevokeOAuthAccess>) {
  return (
    <Suspense>
      <RevokeOAuthAccess {...props} />
    </Suspense>
  );
}
