"use client";

import { useEffect } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { PageContainer, PageHeader, Sheet } from "@/components/ui/page-shell";
import { workspaceBasePath, workspaceSessionsPath, workspaceSettingsPath } from "@/lib/routes";

const WORKSPACE = { id: "fixture-workspace", name: "Acme Robotics", slug: "acme" } as const;

export function AppShellFixture({
  initialTheme = "light",
  section = "pipeline",
}: {
  initialTheme?: "dark" | "light";
  section?: "pipeline" | "sessions" | "settings";
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = initialTheme;
  }, [initialTheme]);

  const pathname =
    section === "sessions"
      ? workspaceSessionsPath(WORKSPACE.slug)
      : section === "settings"
        ? workspaceSettingsPath(WORKSPACE.slug)
        : workspaceBasePath(WORKSPACE.slug);

  const title =
    section === "sessions" ? "Sessions" : section === "settings" ? "Settings" : "Pipeline";

  return (
    <div data-app-shell-fixture="">
      <AppShell
        onboarding={{ currentStep: "verify", status: "completed" }}
        pathnameOverride={pathname}
        viewerEmail="owner@acme.test"
        viewerId="fixture-user"
        workspace={WORKSPACE}
        workspaceAvatarUrl={null}
      >
        <PageContainer>
          <PageHeader
            description="Fixture content for Precision Console shell proof captures."
            title={title}
          />
          <Sheet className="p-5 sm:p-6">
            <p className="text-sm leading-6 text-muted">
              The authenticated shell owns workspace identity, navigation, and the command header.
              Page content scrolls with the document under one vertical scrollbar.
            </p>
            <div className="mt-8 space-y-3" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => (
                <div
                  key={index}
                  className="h-16 rounded-[6px] border border-border bg-control-muted/40"
                />
              ))}
            </div>
          </Sheet>
        </PageContainer>
      </AppShell>
    </div>
  );
}
