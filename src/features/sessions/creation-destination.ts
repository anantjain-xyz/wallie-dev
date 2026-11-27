"use client";

import { useEffect, useState } from "react";

import {
  loadSessionCreationFactoriesFromClient,
  type SessionCreationFactory,
} from "@/features/sessions/client";

export type SessionCreationScope =
  | { kind: "factory"; factory: SessionCreationFactory }
  | { kind: "all" };

export function useSessionCreationDestination(
  scope: SessionCreationScope | undefined,
  open: boolean,
  workspaceId: string,
) {
  const [catalog, setCatalog] = useState<
    | { factories: SessionCreationFactory[]; error?: never }
    | { factories?: never; error: string }
    | null
  >(null);
  const [choice, setChoice] = useState<{ id: string; manual: boolean }>();
  const [revision, setRevision] = useState(0);
  const loadAll = scope?.kind === "all" && open;

  useEffect(() => {
    if (!loadAll) return;
    const controller = new AbortController();
    void loadSessionCreationFactoriesFromClient({ workspaceId, signal: controller.signal }).then(
      (factories) => {
        if (controller.signal.aborted) return;
        setCatalog({ factories });
        if (factories.length === 1) {
          setChoice((current) => current ?? { id: factories[0].id, manual: false });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setCatalog({
            error: error instanceof Error ? error.message : "Couldn’t load factories.",
          });
        }
      },
    );
    return () => controller.abort();
  }, [loadAll, revision, workspaceId]);

  return {
    catalog,
    choose(id: string) {
      setChoice({ id, manual: true });
    },
    factory:
      scope?.kind === "factory"
        ? scope.factory
        : scope?.kind === "all"
          ? catalog?.factories?.find(
              ({ id }, _index, factories) =>
                choice?.id === id && (choice.manual || factories.length === 1),
            )
          : undefined,
    reload() {
      setCatalog(null);
      setRevision((value) => value + 1);
    },
  };
}
