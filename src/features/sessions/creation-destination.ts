"use client";

import { useEffect, useState } from "react";

import {
  loadSessionCreationFactoriesFromClient,
  type SessionCreationFactory,
} from "@/features/sessions/client";

export type SessionCreationScope =
  | { kind: "factory"; factory: SessionCreationFactory }
  | { kind: "pinned"; factory: SessionCreationFactory }
  | { kind: "all" }
  | { kind: "unavailable" };

export function useSessionCreationDestination(
  scope: SessionCreationScope,
  open: boolean,
  workspaceId: string,
  contextKey?: string,
) {
  const editable = scope.kind !== "pinned";
  const seedId = scope.kind === "factory" ? scope.factory.id.toLowerCase() : undefined;
  const choiceContext = JSON.stringify([contextKey, scope.kind, seedId]);
  const loading = editable && open;
  const [catalog, setCatalog] = useState<
    | { context: string; revision: number; factories: SessionCreationFactory[]; error?: never }
    | { context: string; revision: number; factories?: never; error: string }
    | null
  >(null);
  const [choice, setChoice] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [previous, setPrevious] = useState({ choiceContext, loading });
  if (previous.choiceContext !== choiceContext || previous.loading !== loading) {
    setPrevious({ choiceContext, loading });
    if (previous.choiceContext !== choiceContext) setChoice(undefined);
    if (loading) setRevision((value) => value + 1);
  }
  const matchingCatalog = catalog?.context === choiceContext ? catalog : null;
  const currentCatalog = matchingCatalog?.revision === revision ? matchingCatalog : null;
  const factories = matchingCatalog?.factories;
  const selectedId =
    choice ??
    seedId ??
    (scope.kind === "all" && factories?.length === 1 ? factories[0].id.toLowerCase() : undefined);
  const factory =
    scope.kind === "pinned"
      ? scope.factory
      : factories?.find(({ id }) => id.toLowerCase() === selectedId);

  useEffect(() => {
    if (!loading) return;
    const controller = new AbortController();
    void loadSessionCreationFactoriesFromClient({ workspaceId, signal: controller.signal }).then(
      (factories) => {
        if (controller.signal.aborted) return;
        setCatalog({ context: choiceContext, factories, revision });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setCatalog({
            context: choiceContext,
            error: error instanceof Error ? error.message : "Couldn’t load factories.",
            revision,
          });
        }
      },
    );
    return () => controller.abort();
  }, [choiceContext, loading, revision, workspaceId]);

  return {
    catalog: currentCatalog,
    catalogIsCurrent: !editable || currentCatalog !== null,
    choose(id: string) {
      if (currentCatalog?.factories?.some((factory) => factory.id === id)) {
        setChoice(id.toLowerCase());
      }
    },
    editable,
    factory,
    unavailable: !factory && (scope.kind === "unavailable" || Boolean(selectedId)),
    reload() {
      setRevision((value) => value + 1);
    },
  };
}
