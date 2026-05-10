"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { LinearKeySection } from "@/features/settings/linear-key-section";
import { SecretsSection } from "@/features/settings/secrets-section";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import type { ListWorkspaceSecretsResponse, WorkspaceSecretPreview } from "@/lib/secrets/contracts";

type WorkspaceSecretsSectionsProps = {
  canManage: boolean;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

export function WorkspaceSecretsSections({
  canManage,
  setFlashMessage,
  workspaceId,
}: WorkspaceSecretsSectionsProps) {
  const [secrets, setSecrets] = useState<WorkspaceSecretPreview[]>([]);
  const isActiveRef = useRef(false);
  const linearSecret = secrets.find((secret) => secret.key === "LINEAR_API_KEY") ?? null;

  const loadSecretsCall = useCallback(
    () =>
      fetch(`/api/secrets?workspaceId=${encodeURIComponent(workspaceId)}`, {
        cache: "no-store",
      }),
    [workspaceId],
  );

  const handleLoadSecretsSuccess = useCallback((payload: ListWorkspaceSecretsResponse) => {
    if (isActiveRef.current) {
      setSecrets(payload.secrets);
    }
  }, []);

  const { isBusy: isLoadingSecrets, run: loadSecrets } = useApiAction<ListWorkspaceSecretsResponse>(
    {
      call: loadSecretsCall,
      errorText: "Workspace secret loading failed.",
      onSuccess: handleLoadSecretsSuccess,
      setFlashMessage,
      successText: null,
    },
  );

  useEffect(() => {
    if (!canManage) {
      return;
    }

    isActiveRef.current = true;
    void loadSecrets();

    return () => {
      isActiveRef.current = false;
    };
  }, [canManage, loadSecrets]);

  return (
    <>
      <LinearKeySection
        canManage={canManage}
        isLoadingSecrets={isLoadingSecrets}
        linearSecret={linearSecret}
        setFlashMessage={setFlashMessage}
        setSecrets={setSecrets}
        workspaceId={workspaceId}
      />
      <SecretsSection
        canManage={canManage}
        isLoadingSecrets={isLoadingSecrets}
        secrets={secrets}
        setFlashMessage={setFlashMessage}
        setSecrets={setSecrets}
        workspaceId={workspaceId}
      />
    </>
  );
}
