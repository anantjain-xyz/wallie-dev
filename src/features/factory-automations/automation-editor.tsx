"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PageSection } from "@/components/ui/page-shell";
import { factoryAutomationSnapshotSchema } from "@/lib/factory-automations/contracts";
import type { AutomationSetupOptions } from "@/lib/factory-automations/operator-contracts";
import { factoryAutomationApiPath, workspaceAutomationPreviewPath } from "@/lib/routes";

import { AutomationEditorFields, readAutomationDraft } from "./automation-editor-fields";

const snapshotResponse = z.object({ automation: factoryAutomationSnapshotSchema });
type Snapshot = z.infer<typeof factoryAutomationSnapshotSchema>;
type Feedback =
  | { kind: "success" | "error"; message: string }
  | { kind: "conflict"; message: string; createdDraftId?: string }
  | null;

class RuleRequestError extends Error {
  constructor(readonly status: number) {
    super("Automation request failed");
  }
}

async function requestRule(endpoint: string, command?: unknown) {
  const response = await fetch(endpoint, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    ...(command === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        }),
  });
  if (!response.ok) throw new RuleRequestError(response.status);
  return snapshotResponse.parse(await response.json()).automation;
}

function draftError(field: string | number | undefined) {
  if (field === "name") return "Enter a rule name of up to 120 characters.";
  if (field === "target" || field === "executionGrant")
    return "Choose an approved execution target.";
  return "Check the trigger, filter values, and assigned target. Each filter must be unique.";
}

export function AutomationEditor({
  workspaceId,
  workspaceSlug,
  factoryId,
  afterId,
  revisionSelected,
  initial,
  setup,
  setupFailed,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  afterId?: string;
  revisionSelected: boolean;
  initial?: Snapshot;
  setup: AutomationSetupOptions | null;
  setupFailed: boolean;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState(initial);
  const [formInitial] = useState(initial?.revision.definition);
  const [dirty, setDirty] = useState(false);
  const [action, setAction] = useState<"saving" | "publishing" | "loading" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const createId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const endpoint = factoryAutomationApiPath(workspaceId, factoryId, snapshot?.automationId);
  const canSave = snapshot || setup?.assignment;
  const canPublish =
    snapshot && !dirty && snapshot.draftRevisionId !== snapshot.publishedRevisionId;
  const archived = Boolean(snapshot?.archivedAt);

  function changed() {
    setDirty(true);
    if (feedback?.kind !== "conflict") setFeedback(null);
  }

  function rulePath(automation: string) {
    return workspaceAutomationPreviewPath(workspaceSlug, {
      factory: factoryId,
      afterId,
      automation,
    });
  }

  async function perform(kind: "saving" | "publishing" | "loading", work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setAction(kind);
    setFeedback(null);
    try {
      await work();
    } catch (error) {
      if (error instanceof RuleRequestError && error.status === 409) {
        setFeedback({
          kind: "conflict",
          message:
            "This rule changed before your request finished. Your field values are still here.",
          createdDraftId: snapshot ? undefined : (createId.current ?? undefined),
        });
      } else {
        const status = error instanceof RuleRequestError ? error.status : 0;
        setFeedback({
          kind: "error",
          message:
            status === 403 || status === 404
              ? "You no longer have access to this automation."
              : status === 422
                ? "The definition, schedule, or execution target is no longer valid. Check the fields and factory setup."
                : "Could not complete this request. Your field values are still here.",
        });
      }
    } finally {
      inFlight.current = false;
      setAction(null);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || archived || feedback?.kind === "conflict") return;
    const form = event.currentTarget;
    const definition = readAutomationDraft(form, setup, formInitial);
    if (!definition.success) {
      setFeedback({ kind: "error", message: draftError(definition.error.issues[0]?.path[0]) });
      return;
    }
    void perform("saving", async () => {
      if (snapshot) {
        const saved = await requestRule(endpoint, {
          action: "save",
          expectedRevisionId: snapshot.draftRevisionId,
          definition: definition.data,
        });
        if (saved.automationId !== snapshot.automationId) throw new Error("Unexpected automation");
        setSnapshot(saved);
        setDirty(false);
        setFeedback({
          kind: "success",
          message: `Draft revision ${saved.revision.revision} saved.`,
        });
        if (revisionSelected) router.replace(rulePath(saved.automationId));
        else router.refresh();
        return;
      }
      const automationId = createId.current ?? crypto.randomUUID();
      createId.current = automationId;
      let created: Snapshot;
      try {
        created = await requestRule(endpoint, { automationId, definition: definition.data });
      } catch (error) {
        if (!(error instanceof RuleRequestError) || error.status !== 409) throw error;
        try {
          created = await requestRule(
            factoryAutomationApiPath(workspaceId, factoryId, automationId),
          );
        } catch {
          throw error;
        }
        if (JSON.stringify(created.revision.definition) !== JSON.stringify(definition.data))
          throw error;
      }
      if (created.automationId !== automationId) throw new Error("Unexpected automation");
      router.replace(rulePath(created.automationId));
    });
  }

  function publish() {
    if (!snapshot || !canPublish || archived || feedback?.kind === "conflict") return;
    void perform("publishing", async () => {
      const published = await requestRule(endpoint, {
        action: "publish",
        expectedRevisionId: snapshot.draftRevisionId,
      });
      if (published.automationId !== snapshot.automationId)
        throw new Error("Unexpected automation");
      setSnapshot(published);
      setFeedback({
        kind: "success",
        message: `Revision ${published.revision.revision} published.`,
      });
      router.refresh();
    });
  }

  function useLatestRevision() {
    if (!snapshot) return;
    void perform("loading", async () => {
      const latest = await requestRule(endpoint);
      if (latest.automationId !== snapshot.automationId) throw new Error("Unexpected automation");
      if (latest.archivedAt) {
        setFeedback({
          kind: "conflict",
          message: "This automation has been archived. Your field values are still here.",
        });
        return;
      }
      setSnapshot(latest);
      setDirty(true);
      setFeedback({
        kind: "success",
        message: `Revision ${latest.revision.revision} is current. Review your retained field values before saving.`,
      });
    });
  }

  return (
    <PageSection
      title={snapshot ? "Edit draft" : "Set up a rule"}
      tagline={
        snapshot
          ? `Draft revision ${snapshot.revision.revision}`
          : "Choose what starts work and which target runs it."
      }
    >
      <form
        onSubmit={save}
        onChange={changed}
        aria-busy={action !== null}
        className="ui-sheet min-w-0 space-y-5 p-4 sm:p-6"
      >
        {!setup?.assignment ? (
          <p
            role={setupFailed ? "alert" : undefined}
            className={setupFailed ? "text-sm text-danger" : "text-sm text-muted"}
          >
            {setupFailed
              ? "Could not load approved targets. Refresh this page to try again."
              : "Automation requires a published factory definition with a current execution grant and credential binding."}
          </p>
        ) : null}
        <AutomationEditorFields
          initial={formInitial}
          setup={setup}
          changed={changed}
          disabled={action !== null || archived}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="ui-button ui-button-primary"
            type="submit"
            disabled={!canSave || archived || action !== null || feedback?.kind === "conflict"}
          >
            <ActionButtonLabel
              idle="Save draft"
              pending={action === "saving"}
              pendingLabel="Saving…"
            />
          </button>
          {snapshot && snapshot.draftRevisionId !== snapshot.publishedRevisionId ? (
            <button
              type="button"
              className="ui-button"
              onClick={publish}
              disabled={!canPublish || archived || action !== null || feedback?.kind === "conflict"}
            >
              <ActionButtonLabel
                idle={snapshot.publishedRevisionId ? "Publish revision" : "Publish and enable"}
                pending={action === "publishing"}
                pendingLabel="Publishing…"
              />
            </button>
          ) : null}
        </div>
        {dirty && snapshot ? (
          <p className="text-xs text-muted">
            Save draft changes before testing or publishing them.
          </p>
        ) : null}
        {feedback?.kind === "success" ? (
          <p className="text-sm text-success" role="status">
            {feedback.message}
          </p>
        ) : feedback ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-danger">{feedback.message}</p>
            {feedback.kind === "conflict" && snapshot ? (
              <div className="flex flex-wrap gap-2">
                <Link
                  className="ui-button"
                  href={rulePath(snapshot.automationId)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Compare current draft (new tab)
                </Link>
                <button
                  className="ui-button"
                  type="button"
                  onClick={useLatestRevision}
                  disabled={action !== null}
                >
                  Use latest revision and keep edits
                </button>
              </div>
            ) : null}
            {feedback.kind === "conflict" && feedback.createdDraftId ? (
              <Link
                className="ui-button"
                href={rulePath(feedback.createdDraftId)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Check saved draft (new tab)
              </Link>
            ) : null}
          </div>
        ) : null}
      </form>
    </PageSection>
  );
}
