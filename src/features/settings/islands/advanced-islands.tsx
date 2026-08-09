"use client";

import { useEffect, useState } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import {
  SETTINGS_DATA_CHANGED,
  type SettingsDataChangedDetail,
} from "@/features/settings/settings-island-events";
import { MaintenancePanel } from "@/features/settings/maintenance-panel";
import { VerifySetupSection } from "@/features/settings/verify-setup-section";

export function VerifySetupIsland({ initialData }: { initialData: SettingsPageData }) {
  const [data, setData] = useState(initialData);
  const { feedback, setMessage } = useIslandFeedback();
  useEffect(() => {
    const handleDataChange = (event: Event) => {
      const update = (event as CustomEvent<SettingsDataChangedDetail>).detail;
      setData((current) => (typeof update === "function" ? update(current) : update));
    };
    window.addEventListener(SETTINGS_DATA_CHANGED, handleDataChange);
    return () => window.removeEventListener(SETTINGS_DATA_CHANGED, handleDataChange);
  }, []);
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
