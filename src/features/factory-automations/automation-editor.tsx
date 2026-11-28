"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PageSection } from "@/components/ui/page-shell";
import {
  factoryAutomationSnapshotSchema,
  type FactoryAutomationDefinition,
} from "@/lib/factory-automations/contracts";
import type { AutomationSetupOptions } from "@/lib/factory-automations/operator-contracts";
import { factoryAutomationApiPath, workspaceAutomationPreviewPath } from "@/lib/routes";

import { useAutomationDraftNavigation } from "./automation-draft-navigation";
import { AutomationEditorFields, readAutomationDraft } from "./automation-editor-fields";
import { rebaseAutomationDraft } from "./automation-editor-rebase";

const snapshotResponse = z.object({ automation: factoryAutomationSnapshotSchema });
type Snapshot = z.infer<typeof factoryAutomationSnapshotSchema>;
type Feedback =
  | { kind: "success" | "error"; message: string }
  | { kind: "conflict"; message: string }
  | null;
type RebaseOptions = ReturnType<typeof rebaseAutomationDraft> & { latest: Snapshot };

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
  if (field === "stateIds") return "Choose at least one Linear state.";
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
  setupHref,
  savedRepositoryName,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factoryId: string;
  afterId?: string;
  revisionSelected: boolean;
  initial?: Snapshot;
  setup: AutomationSetupOptions | null;
  setupFailed: boolean;
  setupHref?: string;
  savedRepositoryName?: string | null;
}) {
  const router = useRouter();
  const navigation = useAutomationDraftNavigation();
  const [snapshot, setSnapshot] = useState(initial);
  const [fields, setFields] = useState({ initial: initial?.revision.definition, reset: 0 });
  const [dirty, setEditorDirty] = useState(false);
  const [action, setAction] = useState<"saving" | "publishing" | "loading" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [rebaseOptions, setRebaseOptions] = useState<RebaseOptions | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const createAttempt = useRef<{ id: string; definition: FactoryAutomationDefinition } | null>(
    null,
  );
  const inFlight = useRef(false);
  const endpoint = factoryAutomationApiPath(workspaceId, factoryId, snapshot?.automationId);
  const canSave = snapshot || setup?.assignment;
  const canPublish =
    snapshot && !dirty && snapshot.draftRevisionId !== snapshot.publishedRevisionId;
  const archived = Boolean(snapshot?.archivedAt);
  const comparedRule = rebaseOptions?.latest ?? snapshot;

  function setDirty(value: boolean) {
    setEditorDirty(value);
    navigation.setDirty(value);
  }

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
    navigation.setBusy(true);
    setAction(kind);
    setFeedback(null);
    try {
      await work();
    } catch (error) {
      if (kind === "loading") {
        setFeedback({
          kind: "conflict",
          message: "Could not load the current revision. Your field values are still here.",
        });
      } else if (error instanceof RuleRequestError && error.status === 409) {
        setFeedback({
          kind: "conflict",
          message:
            "This rule changed before your request finished. Your field values are still here.",
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
      navigation.setBusy(false);
      setAction(null);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || archived || feedback?.kind === "conflict") return;
    const definition = readAutomationDraft(event.currentTarget, setup, fields.initial);
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
        if (!initial || revisionSelected) router.replace(rulePath(saved.automationId));
        else router.refresh();
        return;
      }
      const attempt = createAttempt.current ?? {
        id: crypto.randomUUID(),
        definition: definition.data,
      };
      createAttempt.current = attempt;
      const automationId = attempt.id;
      let created: Snapshot;
      try {
        created = await requestRule(endpoint, { automationId, definition: definition.data });
      } catch (error) {
        if (!(error instanceof RuleRequestError) || error.status !== 409) throw error;
        created = await requestRule(factoryAutomationApiPath(workspaceId, factoryId, automationId));
        if (created.automationId !== automationId) throw new Error("Unexpected automation");
        if (JSON.stringify(created.revision.definition) !== JSON.stringify(definition.data)) {
          prepareRebase(created, attempt.definition, definition.data);
          return;
        }
      }
      if (created.automationId !== automationId) throw new Error("Unexpected automation");
      setDirty(false);
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
      if (!initial) router.replace(rulePath(published.automationId));
      else router.refresh();
    });
  }

  function applyRebase(latest: Snapshot, definition: FactoryAutomationDefinition) {
    const hasChanges = JSON.stringify(definition) !== JSON.stringify(latest.revision.definition);
    setSnapshot(latest);
    setFields(({ reset }) => ({ initial: definition, reset: reset + 1 }));
    setDirty(hasChanges);
    setRebaseOptions(null);
    setFeedback({
      kind: "success",
      message: hasChanges
        ? `Revision ${latest.revision.revision} is current. Review the merged draft before saving.`
        : `Revision ${latest.revision.revision} is current.`,
    });
  }

  function prepareRebase(
    latest: Snapshot,
    base: FactoryAutomationDefinition,
    edits: FactoryAutomationDefinition,
  ) {
    if (latest.archivedAt) {
      setSnapshot(latest);
      setFeedback({
        kind: "error",
        message: "This automation has been archived. Your field values are still here.",
      });
      return;
    }
    const options = rebaseAutomationDraft(base, edits, latest.revision.definition);
    if (!options.conflicts.length) {
      applyRebase(latest, options.keepEdits);
      return;
    }
    setRebaseOptions({ latest, ...options });
    setFeedback({
      kind: "conflict",
      message: `Both drafts changed the same sections (${options.conflicts.join(", ")}). Choose which values to keep.`,
    });
  }

  function useLatestRevision() {
    if (!snapshot || !form.current) return;
    const edits = readAutomationDraft(form.current, setup, fields.initial);
    if (!edits.success) {
      setFeedback({
        kind: "conflict",
        message: "Complete the rule fields before merging with the current draft.",
      });
      return;
    }
    void perform("loading", async () => {
      const latest = await requestRule(endpoint);
      if (latest.automationId !== snapshot.automationId) throw new Error("Unexpected automation");
      prepareRebase(latest, snapshot.revision.definition, edits.data);
    });
  }

  const setupNotice = !setup?.assignment ? (
    <div className="space-y-2 text-sm">
      <p
        role={setupFailed ? "alert" : undefined}
        className={setupFailed ? "text-danger" : "text-muted"}
      >
        {setupFailed
          ? "Could not check approved targets. Refresh this page to try again."
          : setupHref
            ? "No approved target is available. Review the published factory definition, its execution grant, and its credential binding."
            : "No approved target is available. Ask a workspace owner or admin to check the published factory definition and its execution access."}
      </p>
      {!setupFailed && setupHref ? (
        <Link href={setupHref} className="text-accent underline underline-offset-4">
          Review Factory definition
        </Link>
      ) : null}
    </div>
  ) : null;

  if (!canSave) {
    return (
      <PageSection
        title="Set up a rule"
        tagline="An approved execution target is required before you can create a rule."
      >
        <div className="ui-sheet p-4 sm:p-6">{setupNotice}</div>
      </PageSection>
    );
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
        ref={form}
        onSubmit={save}
        onChange={changed}
        aria-busy={action !== null}
        className="ui-sheet min-w-0 space-y-5 p-4 sm:p-6"
      >
        {setupNotice}
        <AutomationEditorFields
          key={fields.reset}
          initial={fields.initial}
          setup={setup}
          savedRepositoryName={savedRepositoryName}
          changed={changed}
          disabled={action !== null || archived || rebaseOptions !== null}
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
        {dirty ? (
          <p className="text-xs text-muted">
            {snapshot
              ? "Unsaved changes. Dry run still uses the saved revision."
              : "Unsaved changes. Save a draft to preview this rule."}
          </p>
        ) : null}
        {feedback?.kind === "success" ? (
          <p className="text-sm text-success" role="status">
            {feedback.message}
          </p>
        ) : feedback ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-danger">{feedback.message}</p>
            {feedback.kind === "conflict" && comparedRule ? (
              <div className="flex flex-wrap gap-2">
                <Link
                  className="ui-button"
                  href={rulePath(comparedRule.automationId)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Compare current draft (new tab)
                </Link>
                {rebaseOptions ? (
                  <>
                    <button
                      className="ui-button"
                      type="button"
                      onClick={() => applyRebase(rebaseOptions.latest, rebaseOptions.keepEdits)}
                    >
                      Keep my conflicting edits
                    </button>
                    <button
                      className="ui-button"
                      type="button"
                      onClick={() => applyRebase(rebaseOptions.latest, rebaseOptions.keepSaved)}
                    >
                      Use saved values for conflicts
                    </button>
                  </>
                ) : (
                  <button
                    className="ui-button"
                    type="button"
                    onClick={useLatestRevision}
                    disabled={action !== null}
                  >
                    Use latest revision and keep edits
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </PageSection>
  );
}
