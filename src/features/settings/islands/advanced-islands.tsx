"use client";

import { useState } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import { MaintenancePanel } from "@/features/settings/maintenance-panel";
import { VerifySetupSection } from "@/features/settings/verify-setup-section";

export function VerifySetupIsland({ initialData }: { initialData: SettingsPageData }) {
  const [data, setData] = useState(initialData);
  const { feedback, setMessage } = useIslandFeedback();
  return (
    <>
      {feedback}
      <VerifySetupSection data={data} setData={setData} setFlashMessage={setMessage} />
    </>
  );
}

export function MaintenanceIsland({
  canManage,
  workspaceId,
}: {
  canManage: boolean;
  workspaceId: string;
}) {
  const { feedback, setMessage } = useIslandFeedback();
  if (!canManage) {
    return null;
  }

  return (
    <div className="mt-6 space-y-4">
      {feedback}
      <MaintenancePanel
        canManage
        className="mt-0"
        setFlashMessage={setMessage}
        workspaceId={workspaceId}
      />
    </div>
  );
}
