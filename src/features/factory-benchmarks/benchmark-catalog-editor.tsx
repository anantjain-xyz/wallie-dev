"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { PageHeader, PageSection } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import {
  factorySwitchHref,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";

import { SuiteCurationForm } from "./suite-curation-form";
import type { BenchmarkTaskChoice } from "./suites-data";

export function BenchmarkCatalogEditor({
  catalogHref,
  factories,
  factoryId,
  taskChoices,
  workspaceId,
  workspaceSlug,
}: {
  catalogHref: string;
  factories: readonly FactorySelectionOption[];
  factoryId: string;
  taskChoices: readonly BenchmarkTaskChoice[];
  workspaceId: string;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<"clean" | "dirty" | "saving">("clean");
  const [switching, startSwitch] = useTransition();
  return (
    <>
      <PageHeader
        title="Benchmarks"
        description="Build suites of captured tasks to compare factory configurations against the same work."
        actionsRightOnDesktop
        actions={
          <SelectField
            className="min-w-0 max-w-full sm:max-w-52"
            disabled={status === "saving" || switching}
            label="Factory"
            labelClassName="type-label"
            onValueChange={(value) => {
              if (value === factoryId || status === "saving" || switching) return;
              if (
                status === "dirty" &&
                !window.confirm("Switch factories and discard your unsaved suite changes?")
              )
                return;
              const current = new URL(catalogHref, window.location.origin);
              startSwitch(() =>
                router.push(factorySwitchHref(current.pathname, current.search, value)),
              );
            }}
            options={factories.map(({ id, name, status }) => ({
              value: id,
              label: `${name}${status === "archived" ? " (archived)" : ""}`,
            }))}
            value={factoryId}
            wrap
          />
        }
      />
      <PageSection anchorId="new-suite" className="scroll-mt-24" title="New suite">
        <SuiteCurationForm
          cancelHref={catalogHref}
          factoryId={factoryId}
          onDraftStatusChange={setStatus}
          taskChoices={taskChoices}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
        />
      </PageSection>
    </>
  );
}
