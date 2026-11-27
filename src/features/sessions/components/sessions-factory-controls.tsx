import Link from "next/link";

import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { workspaceFactoriesPath } from "@/lib/routes";

export function SessionsFactoryControls({
  canManageFactories,
  factories,
  resetParams,
  selectedValue,
  workspaceSlug,
}: {
  canManageFactories: boolean;
  factories: readonly FactorySelectionOption[];
  resetParams?: readonly string[];
  selectedValue: string;
  workspaceSlug: string;
}) {
  return (
    <>
      <FactorySelector
        allowAll
        factories={factories}
        resetParams={resetParams}
        selectedValue={selectedValue}
      />
      {canManageFactories ? (
        <Link
          className="ui-button min-h-11 sm:min-h-9"
          href={workspaceFactoriesPath(workspaceSlug)}
        >
          Manage factories
        </Link>
      ) : null}
    </>
  );
}
