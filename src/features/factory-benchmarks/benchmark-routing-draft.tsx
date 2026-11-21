"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  routingDraftRequestSchema,
  routingDraftResponseSchema,
  type RoutingDraftRequest,
} from "@/lib/model-routing/draft-contracts";
import { workspaceFactoryDefinitionPath } from "@/lib/routes";

type Candidate = { key: string; label: string };

type RoutingDraftSelection = (candidate: Candidate, trigger: HTMLButtonElement) => void;

const RoutingDraftContext = createContext<RoutingDraftSelection | null>(null);
const routingDraftInputSchema = routingDraftRequestSchema.omit({ requestId: true });

export function ApplyToRoutingButton({ candidate }: { candidate: Candidate }) {
  const selectCandidate = useContext(RoutingDraftContext);
  if (!selectCandidate) return null;

  return (
    <button
      aria-haspopup="dialog"
      className="ui-button mt-2 max-w-full px-2 text-left whitespace-normal"
      onClick={(event) => selectCandidate(candidate, event.currentTarget)}
      type="button"
    >
      Apply to routing
    </button>
  );
}

type DraftContext = {
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  experimentId: string;
  suiteRevisionId: string;
  scorerRevisionId: string;
  qualityFloorBps: number;
  minimumResolved: number;
};

function readNumber(fields: FormData, name: string) {
  const value = fields.get(name);
  return typeof value === "string" && value.trim() ? Number(value) : null;
}

export function BenchmarkRoutingDraft({
  context,
  children,
}: {
  context: DraftContext;
  children: ReactNode;
}) {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const {
    workspaceId,
    workspaceSlug,
    factoryId,
    experimentId,
    suiteRevisionId,
    scorerRevisionId,
    qualityFloorBps,
    minimumResolved,
  } = context;
  const action = useApiAction<unknown, [RoutingDraftRequest]>({
    call: (command) =>
      fetch(
        `/api/workspaces/${workspaceId}/factories/${factoryId}/benchmarks/experiments/${experimentId}/routing-drafts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      ),
    errorText: "Could not create the routing draft.",
    setFlashMessage: setMessage,
    successText: "Routing draft created.",
    onSuccess: (payload) => {
      const parsed = routingDraftResponseSchema.safeParse(payload);
      if (!parsed.success)
        throw new Error("The routing draft response was invalid. Retry to recover it.");
      setDraftId(parsed.data.draftId);
    },
  });

  const selectCandidate = useCallback((next: Candidate, button: HTMLButtonElement) => {
    trigger.current = button;
    setCandidate(next);
    setDraftId(null);
    setMessage(null);
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!candidate || draftId) return;

    const fields = new FormData(event.currentTarget);
    const quality = readNumber(fields, "qualityFloorPercent");
    const payload = {
      candidateKey: candidate.key,
      scorerRevisionId,
      suiteRevisionId,
      taskClass: {
        slug: String(fields.get("taskClassSlug") ?? "").trim(),
        name: String(fields.get("taskClassName") ?? "").trim(),
      },
      constraints: {
        qualityFloorBps: quality === null ? null : Math.round(quality * 100),
        maxMeanCostUsd: readNumber(fields, "maxMeanCostUsd"),
        maxLatencyMs: readNumber(fields, "maxLatencyMs"),
        minResolvedTrials: readNumber(fields, "minResolvedTrials"),
        minConfidenceBps: null,
      },
    };
    const parsed = routingDraftInputSchema.safeParse(payload);
    if (!parsed.success) {
      setMessage({ kind: "error", text: "Check the task class and evidence requirements." });
      return;
    }
    const key = JSON.stringify(parsed.data);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    setMessage(null);
    void action.run({ ...parsed.data, requestId: request.current.id });
  }

  return (
    <RoutingDraftContext value={selectCandidate}>
      {children}
      <Dialog
        onOpenChange={(open) => {
          if (!open && !action.isBusy) setCandidate(null);
        }}
        open={candidate !== null}
      >
        <DialogContent
          description={candidate?.label}
          dismissible={!action.isBusy}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          title="Apply to routing"
        >
          {draftId ? (
            <>
              <InlineActionMessage message={message} />
              <DialogFooter>
                <DialogClose className="ui-button">Close</DialogClose>
                <Link
                  className="ui-button ui-button-primary"
                  href={workspaceFactoryDefinitionPath(workspaceSlug, {
                    factory: factoryId,
                    draft: draftId,
                  })}
                >
                  Open routing draft
                </Link>
              </DialogFooter>
            </>
          ) : (
            <form className="space-y-4" onChange={() => setMessage(null)} onSubmit={submit}>
              <InlineActionMessage message={message} />
              <fieldset
                aria-busy={action.isBusy}
                className="min-w-0 space-y-4"
                disabled={action.isBusy}
              >
                <legend className="sr-only">Routing draft settings</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="type-label grid gap-1.5">
                    Task class name
                    <input
                      className="ui-input w-full min-w-0"
                      maxLength={120}
                      name="taskClassName"
                      required
                    />
                  </label>
                  <label className="type-label grid gap-1.5">
                    Task class slug
                    <input
                      className="ui-input w-full min-w-0"
                      maxLength={60}
                      name="taskClassSlug"
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      required
                      title="Use lowercase letters, numbers, and hyphens."
                    />
                  </label>
                  <label className="type-label grid gap-1.5">
                    Quality floor (%)
                    <input
                      className="ui-input w-full min-w-0"
                      defaultValue={qualityFloorBps / 100}
                      max={100}
                      min={0}
                      name="qualityFloorPercent"
                      required
                      step={0.01}
                      type="number"
                    />
                  </label>
                  <label className="type-label grid gap-1.5">
                    Minimum resolved trials
                    <input
                      className="ui-input w-full min-w-0"
                      defaultValue={minimumResolved}
                      max={10_000}
                      min={2}
                      name="minResolvedTrials"
                      required
                      step={1}
                      type="number"
                    />
                  </label>
                  <label className="type-label grid gap-1.5">
                    Maximum mean cost (USD)
                    <input
                      className="ui-input w-full min-w-0"
                      max={1_000_000}
                      min={0}
                      name="maxMeanCostUsd"
                      step="any"
                      type="number"
                    />
                  </label>
                  <label className="type-label grid gap-1.5">
                    Maximum p95 wall latency (ms)
                    <input
                      className="ui-input w-full min-w-0"
                      max={86_400_000}
                      min={1}
                      name="maxLatencyMs"
                      step={1}
                      type="number"
                    />
                  </label>
                </div>
                <p className="type-secondary text-muted">
                  Leave cost and latency limits blank to omit those ceilings.
                </p>
              </fieldset>
              <DialogFooter>
                <DialogClose className="ui-button" disabled={action.isBusy}>
                  Cancel
                </DialogClose>
                <button
                  className="ui-button ui-button-primary"
                  disabled={action.isBusy}
                  type="submit"
                >
                  <ActionButtonLabel
                    idle="Create routing draft"
                    pending={action.isBusy}
                    pendingLabel="Creating draft"
                  />
                </button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </RoutingDraftContext>
  );
}
