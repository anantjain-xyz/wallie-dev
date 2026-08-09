"use client";

import { useEffect, useState } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import {
  registerSettingsDataReplayConsumer,
  replaySettingsDataChanges,
  SETTINGS_DATA_CHANGED,
  type SettingsDataChangedDetail,
} from "@/features/settings/settings-island-events";
import { MaintenancePanel } from "@/features/settings/maintenance-panel";
import { VerifySetupSection } from "@/features/settings/verify-setup-section";

export function VerifySetupIsland({ initialData }: { initialData: SettingsPageData }) {
  const [data, setData] = useState(() => replaySettingsDataChanges(initialData, "verify-setup"));
  const { feedback, setMessage } = useIslandFeedback();
  useEffect(() => {
    return registerSettingsDataReplayConsumer(initialData.workspace.id, "verify-setup");
  }, [initialData.workspace.id]);
  useEffect(() => {
    const handleDataChange = (event: Event) => {
      const { update, workspaceId } = (event as CustomEvent<SettingsDataChangedDetail>).detail;
      if (workspaceId !== initialData.workspace.id) return;
      setData((current) => (typeof update === "function" ? update(current) : update));
    };
    window.addEventListener(SETTINGS_DATA_CHANGED, handleDataChange);
    return () => window.removeEventListener(SETTINGS_DATA_CHANGED, handleDataChange);
  }, [initialData.workspace.id]);
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
    <section className="scroll-mt-8 space-y-4" id="maintenance">
      {feedback}
      <MaintenancePanel
        canManage
        className="mt-0"
        setFlashMessage={setMessage}
        workspaceId={workspaceId}
      />
    </section>
  );
}
