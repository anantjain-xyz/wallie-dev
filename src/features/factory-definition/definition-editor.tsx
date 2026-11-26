"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { FactoryCapabilityProbe } from "@/features/factory-definition/capability-probe";
import { DraftConflictReview } from "@/features/factory-definition/draft-conflict-review";
import { sameDefinitionValue, type DraftInput } from "@/features/factory-definition/draft-review";
import { FactoryExecutionProfilePanel } from "@/features/factory-definition/execution-profile-panel";
import {
  draftSavedSchema,
  factoryEditorPost,
  FactoryEditorRequestError,
  fetchFactoryEditor,
  type EditorDiagnostic,
  type FactoryEditorHistory,
} from "@/features/factory-definition/editor-requests";
import { CandidateTestPanel } from "@/features/factory-definition/candidate-test-panel";
import {
  FactoryDefinitionSwitch,
  type FactoryDefinitionSelection,
} from "@/features/factory-definition/factory-definition-switch";
import { FactoryMcpManifestInspector } from "@/features/factory-definition/mcp-manifest-inspector";
import { FactoryRevisionHistory } from "@/features/factory-definition/revision-history";
import {
  ReviewedRoutingActivation,
  type ReviewedRoutingActivationTarget,
} from "@/features/factory-definition/reviewed-routing-activation";
import { RoutingDraftEvidencePanel } from "@/features/factory-definition/routing-draft-evidence";
import { FactoryRoutingPreview } from "@/features/factory-definition/routing-preview";
import { RoutingQualificationNotice } from "@/features/factory-definition/routing-qualification-notice";
import { FactoryScorerBindings } from "@/features/factory-definition/scorer-bindings";
import { FactorySemanticDiff } from "@/features/factory-definition/semantic-diff";
import { ServiceCredentialsPanel } from "@/features/factory-definition/service-credentials-panel";
import { StructuredFactoryDefinitionEditor } from "@/features/factory-definition/structured-editor";
import { useCandidateTests } from "@/features/factory-definition/use-candidate-tests";
import { notifySessionRepositoriesChanged } from "@/features/sessions/session-repository-cache-events";
import type { CapabilityRepository } from "@/features/settings/sandbox-capability-section";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { parseOpenCodeModelId } from "@/lib/agent-config/contracts";
import {
  factoryEditorDocumentResponseSchema,
  factoryEditorHistoryResponseSchema,
  factoryEditorPreviewResponseSchema,
  factoryEditorSnapshotResponseSchema,
  type FactoryEditorActivation,
  type FactoryEditorContent,
  type FactoryEditorDocument,
  type FactoryEditorSnapshot,
} from "@/lib/factory-definitions/editor-contracts";
import type { FactoryEditorReferenceOptions } from "@/lib/factory-definitions/editor-reference-options";
import {
  FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
  MAX_FACTORY_SCORER_REVISIONS,
  type SerialFactoryDefinition,
} from "@/lib/factory-definitions/schema";
import type { FactorySecretBindingScope } from "@/lib/factory-secret-bindings/contracts";
import {
  workspaceAnalyticsPath,
  workspaceBenchmarksPath,
  workspaceFactoryDefinitionPath,
  workspaceSettingsPath,
} from "@/lib/routes";

type AgentSelection = { agentId: string; promptRevisionId: string };
type Selection = (
  | { revision: string; activation?: number; restoreFrom?: number }
  | { draft: string }
) & {
  test?: string;
};
type Edit = {
  input: DraftInput;
  original: SerialFactoryDefinition;
  activationNumber: number;
  draftId: string | null;
};
const recoverableEdits = new Map<string, Edit>();
type Operation =
  | "reload"
  | "preview"
  | "save"
  | "publish"
  | "activate-routing"
  | "select"
  | "history"
  | "rollback";
const activationSavedSchema = z.object({ activation: z.object({ revisionId: z.string().uuid() }) });

function sourceText(source: SerialFactoryDefinition) {
  return JSON.stringify(source, null, 2);
}

function workingSource(snapshot: FactoryEditorSnapshot) {
  return (snapshot.draft ?? snapshot.published ?? snapshot.baseline)?.source;
}

function credentialScopeFrom(
  target: FactoryEditorDocument | null | undefined,
): FactorySecretBindingScope | null {
  const definition = target?.bundle;
  if (!definition?.executionGrant || !definition.implementationAgent) return null;
  const { provider, model } = definition.agent;
  const scope = {
    bindingId: definition.credentialBindingId,
    grantId: definition.executionGrant.id,
    grantVersion: definition.executionGrant.version,
    agentId: definition.implementationAgent.agentId,
  };
  if (provider !== "opencode") return { ...scope, provider };
  const parsed = parseOpenCodeModelId(model);
  return parsed ? { ...scope, provider, openCodeProviderId: parsed.providerId } : null;
}

function editFrom(
  snapshot: FactoryEditorSnapshot,
  mode: DraftInput["kind"] = "structured",
  initialAgent?: AgentSelection,
  initialScorerRevisionId?: string,
): Edit | null {
  const document = snapshot.draft ?? snapshot.published;
  const original = workingSource(snapshot);
  if (!original) return null;
  let value = { ...original };
  if (initialAgent) {
    value.implementationAgent = initialAgent.promptRevisionId;
    if (document?.bundle.implementationAgent?.agentId !== initialAgent.agentId) {
      delete value.credentialBindingId;
      if (value.mcpBindings?.some((binding) => binding.secretBindingId)) {
        value.mcpBindings = value.mcpBindings.map((binding) => {
          const next = { ...binding };
          delete next.secretBindingId;
          return next;
        });
      }
    }
  }
  const scorerRevisionIds =
    value.schemaVersion === FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION
      ? value.scorerRevisionIds
      : [];
  if (
    initialScorerRevisionId &&
    !scorerRevisionIds.includes(initialScorerRevisionId) &&
    scorerRevisionIds.length < MAX_FACTORY_SCORER_REVISIONS
  ) {
    value = {
      ...value,
      schemaVersion: FACTORY_DEFINITION_SCORERS_SCHEMA_VERSION,
      scorerRevisionIds: [...scorerRevisionIds, initialScorerRevisionId],
    };
  }
  return {
    original,
    input:
      mode === "structured"
        ? { kind: "structured", value }
        : { kind: "json", text: sourceText(value) },
    activationNumber: snapshot.activationNumber,
    draftId: snapshot.draft?.id ?? null,
  };
}

function editChanged(edit: Edit) {
  return edit.input.kind === "structured"
    ? sourceText(edit.input.value) !== sourceText(edit.original)
    : edit.input.text !== sourceText(edit.original);
}

function expectedVersion(edit: Edit) {
  return {
    expectedActivationNumber: edit.activationNumber,
    expectedDraftId: edit.draftId,
  };
}

function readDefinition(endpoint: string, selection: Selection, signal?: AbortSignal) {
  const query = new URLSearchParams(
    "revision" in selection ? [["revisionId", selection.revision]] : [["draftId", selection.draft]],
  );
  if ("revision" in selection && selection.activation) {
    query.set("activationNumber", String(selection.activation));
  }
  return fetchFactoryEditor(`${endpoint}?${query}`, factoryEditorDocumentResponseSchema, {
    signal,
  }).then(({ document }) => document);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Could not update the factory definition.";
}

export function FactoryDefinitionEditor({
  factoryId,
  factoryName,
  factorySelection,
  initialAgent,
  initialScorerRevisionId,
  workspaceId,
  workspaceSlug,
  selection,
  repositories,
  recoveryKey,
  referenceOptions,
}: {
  factoryId?: string;
  factoryName?: string;
  factorySelection?: FactoryDefinitionSelection;
  initialAgent?: AgentSelection;
  initialScorerRevisionId?: string;
  workspaceId: string;
  workspaceSlug: string;
  selection: Selection | null;
  repositories: readonly CapabilityRepository[];
  recoveryKey?: string;
  referenceOptions?: FactoryEditorReferenceOptions;
}) {
  const api = factoryId
    ? `/api/workspaces/${workspaceId}/factories/${factoryId}/definition`
    : `/api/workspaces/${workspaceId}/factory-definition`;
  const initialAgentId = initialAgent?.agentId;
  const initialPromptRevisionId = initialAgent?.promptRevisionId;
  const editorApi = `${api}/editor`;
  const [snapshot, setSnapshot] = useState<FactoryEditorSnapshot | null>(null);
  const [history, setHistory] = useState<FactoryEditorHistory | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [selected, setSelected] = useState<FactoryEditorDocument | null>(null);
  const [preview, setPreview] = useState<FactoryEditorContent | null>(null);
  const [pending, setPending] = useState<Operation | null>(null);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const [diagnostics, setDiagnostics] = useState<EditorDiagnostic[]>([]);
  const [profileRefresh, setProfileRefresh] = useState(0);
  const refreshProfile = useCallback(() => setProfileRefresh((value) => value + 1), []);
  const refreshProfileAfterCheck = useCallback(
    (check: { status: string }) => {
      if (check.status !== "running") refreshProfile();
    },
    [refreshProfile],
  );
  const inFlight = useRef(false);
  const reloadButtonRef = useRef<HTMLButtonElement>(null);
  const conflictReloadRef = useRef<HTMLButtonElement>(null);
  const editControlsRef = useRef<HTMLDivElement>(null);
  const scrolledSelectionUrl = useRef<string | null>(null);
  const dirty = edit ? editChanged(edit) : false;
  const latestSource = snapshot ? workingSource(snapshot) : undefined;
  const stale =
    edit !== null &&
    snapshot !== null &&
    (edit.activationNumber !== snapshot.activationNumber ||
      edit.draftId !== (snapshot.draft?.id ?? null) ||
      (!edit.draftId &&
        edit.activationNumber === 0 &&
        !sameDefinitionValue(edit.original, latestSource)));
  const busy = loading || pending !== null;
  const locked = busy || conflict || stale;
  const conflictReason = stale
    ? "Review the latest definition before testing."
    : conflict
      ? "Reload the definition before testing."
      : null;
  const selectedRevision = selected?.kind === "revision" ? selected.id : null;
  const selectedActivationNumber =
    selected?.activationNumber ??
    history?.activations.find(({ revisionId }) => revisionId === selectedRevision)
      ?.activationNumber;
  const draft = snapshot?.draft ?? null;
  const routingDraftEvidence = (selected ?? draft)?.routingDraftEvidence;
  const selectedMatchesDraft =
    draft !== null && selected?.kind === "draft" && selected.id === draft.id;
  const historyCandidate = selectedMatchesDraft ? null : selected;
  const isRollbackCandidate = Boolean(
    selectedActivationNumber && snapshot?.published && selectedRevision !== snapshot.published.id,
  );
  const activationNumber = snapshot?.activationNumber ?? 0;
  const requestedDraft = selection && "draft" in selection ? selection.draft : null;
  const requestedRevision = selection && "revision" in selection ? selection.revision : null;
  const requestedActivation =
    selection && "revision" in selection ? selection.activation : undefined;
  const requestedRestoreFrom =
    selection && "revision" in selection ? selection.restoreFrom : undefined;
  const restoreHeadChanged =
    snapshot !== null &&
    requestedRestoreFrom !== undefined &&
    requestedRestoreFrom !== activationNumber;
  const restoreConflict = restoreHeadChanged
    ? "The rollback link is stale. Return to the proposal to review the current activation."
    : null;
  const draftTests = useCandidateTests({
    api,
    target: draft,
    activationNumber,
    active: true,
    initialTestId: draft && draft.id === requestedDraft ? selection?.test : undefined,
  });
  const reviewedRoutingTest = draftTests.eligible
    ? draftTests.panel.tests.find(
        ({ baseActivationNumber }) => baseActivationNumber === activationNumber,
      )
    : undefined;
  const revisionTests = useCandidateTests({
    api,
    target: historyCandidate,
    activationNumber,
    active: isRollbackCandidate,
    initialTestId:
      historyCandidate && historyCandidate.id === (requestedRevision ?? requestedDraft)
        ? selection?.test
        : undefined,
  });
  const capabilityTarget = selected ?? snapshot?.draft ?? snapshot?.published;
  const manifestTarget = preview ?? capabilityTarget;
  const manifestTargetLabel = preview
    ? "Validated edit"
    : capabilityTarget?.kind === "draft"
      ? "Saved draft"
      : selected
        ? "Selected revision"
        : "Published definition";
  const credentialScope = credentialScopeFrom(capabilityTarget);
  const workingTarget = snapshot?.draft ?? snapshot?.published;
  const canUseCredentialBinding =
    Boolean(edit && workingTarget && workingTarget.id === capabilityTarget?.id) &&
    !locked &&
    !dirty;
  const useHistoricalTestAnchor =
    requestedRestoreFrom !== undefined || Boolean(historyCandidate && selection?.test);
  const anchorCandidate = useHistoricalTestAnchor ? historyCandidate : (draft ?? historyCandidate);
  const anchorReady =
    Boolean(anchorCandidate) &&
    (!selection?.test || anchorCandidate?.id === (requestedRevision ?? requestedDraft));

  useEffect(() => {
    if (!dirty) return;
    const preserveEdit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", preserveEdit);
    return () => window.removeEventListener("beforeunload", preserveEdit);
  }, [dirty]);

  useEffect(() => {
    if (!recoveryKey || !snapshot) return;
    if (dirty && edit) recoverableEdits.set(recoveryKey, edit);
    else recoverableEdits.delete(recoveryKey);
  }, [dirty, edit, recoveryKey, snapshot]);

  useEffect(() => {
    if (conflict && !busy) conflictReloadRef.current?.focus();
  }, [busy, conflict]);

  useEffect(() => {
    const { hash, href } = window.location;
    const candidateAnchor = anchorReady && hash === "#candidate-tests";
    const rollbackAnchor =
      hash === "#revision-history" &&
      requestedActivation !== undefined &&
      requestedActivation === selected?.activationNumber;
    if ((!candidateAnchor && !rollbackAnchor) || scrolledSelectionUrl.current === href) return;
    const anchor = document.getElementById(hash.slice(1));
    if (!anchor) return;
    anchor.scrollIntoView?.({ block: "start" });
    scrolledSelectionUrl.current = href;
  }, [anchorReady, requestedActivation, selected?.activationNumber, selection?.test]);

  const loadWorkspace = useCallback(
    async (signal?: AbortSignal) => {
      const [{ snapshot }, history] = await Promise.all([
        fetchFactoryEditor(editorApi, factoryEditorSnapshotResponseSchema, { signal }),
        fetchFactoryEditor(api, factoryEditorHistoryResponseSchema, { signal }),
      ]);
      return { snapshot, history };
    },
    [api, editorApi],
  );

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      try {
        const current = await loadWorkspace(signal);
        if (signal.aborted) return;
        setSnapshot(current.snapshot);
        setHistory(current.history);
        const recovered = recoveryKey ? recoverableEdits.get(recoveryKey) : undefined;
        setEdit(
          recovered ??
            editFrom(
              current.snapshot,
              "structured",
              initialAgentId && initialPromptRevisionId
                ? { agentId: initialAgentId, promptRevisionId: initialPromptRevisionId }
                : undefined,
              initialScorerRevisionId,
            ),
        );
        if (recovered) {
          setFeedback({ kind: "info", text: "Your unsaved edits from this tab were restored." });
        }
      } catch (error) {
        if (!signal.aborted) setFeedback({ kind: "error", text: errorText(error) });
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [
    initialAgentId,
    initialPromptRevisionId,
    initialScorerRevisionId,
    loadWorkspace,
    recoveryKey,
  ]);

  useEffect(() => {
    const target = requestedRevision
      ? { revision: requestedRevision, activation: requestedActivation }
      : requestedDraft
        ? { draft: requestedDraft }
        : null;
    if (!target) return;
    const controller = new AbortController();
    const { signal } = controller;
    void readDefinition(editorApi, target, signal).then(
      (document) => {
        if (!signal.aborted) setSelected(document);
      },
      (error: unknown) => {
        if (!signal.aborted) setFeedback({ kind: "error", text: errorText(error) });
      },
    );
    return () => controller.abort();
  }, [editorApi, requestedActivation, requestedDraft, requestedRevision]);

  async function run(operation: Operation, task: () => Promise<void>) {
    if (inFlight.current || loading) return;
    inFlight.current = true;
    setPending(operation);
    setFeedback(null);
    setDiagnostics([]);
    try {
      await task();
    } catch (error) {
      if (error instanceof FactoryEditorRequestError) {
        if (error.status === 409) {
          setConflict(true);
          setPreview(null);
        }
        setDiagnostics(error.diagnostics);
      }
      setFeedback({ kind: "error", text: errorText(error) });
      return error;
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function replaceInput(input: DraftInput) {
    setEdit((current) => (current ? { ...current, input } : current));
    setPreview(null);
    setDiagnostics([]);
    setFeedback(null);
  }

  async function reload() {
    await run("reload", async () => {
      const currentTarget = selected
        ? selected.kind === "draft"
          ? { draft: selected.id }
          : { revision: selected.id, activation: selectedActivationNumber }
        : null;
      const current = await loadWorkspace();
      setSnapshot(current.snapshot);
      setHistory(current.history);
      setPreview(null);
      setConflict(false);
      if (!dirty) setEdit(editFrom(current.snapshot, edit?.input.kind));
      draftTests.refresh();
      revisionTests.refresh();
      refreshProfile();
      if (currentTarget) setSelected(await readDefinition(editorApi, currentTarget));
    });
  }

  async function compile(current: Edit) {
    const { content } = await fetchFactoryEditor(
      editorApi,
      factoryEditorPreviewResponseSchema,
      factoryEditorPost({ ...expectedVersion(current), source: current.input }),
    );
    return content;
  }

  async function changeMode(mode: DraftInput["kind"]) {
    if (!edit || edit.input.kind === mode) return;
    if (edit.input.kind === "structured") {
      replaceInput({ kind: "json", text: sourceText(edit.input.value) });
      return;
    }
    await run("preview", async () => {
      const content = await compile(edit);
      setEdit({ ...edit, input: { kind: "structured", value: content.source } });
      setPreview(content);
    });
  }

  async function validate() {
    if (!edit || locked) return;
    await run("preview", async () => {
      setPreview(await compile(edit));
      setFeedback({ kind: "success", text: "Definition is valid. Review its semantic changes." });
    });
  }

  async function save() {
    if (!edit || !snapshot || locked) return;
    await run("save", async () => {
      const { draft } = await fetchFactoryEditor(
        api,
        draftSavedSchema,
        factoryEditorPost({ action: "draft", ...expectedVersion(edit), source: edit.input }),
      );
      // Read the acknowledged immutable draft rather than a potentially newer working draft.
      const saved = await readDefinition(editorApi, { draft: draft.id });
      const next = { ...snapshot, draft: saved };
      setSnapshot(next);
      setEdit(editFrom(next, edit.input.kind));
      setPreview(null);
      setFeedback({ kind: "success", text: "Draft saved." });
    });
  }

  async function refreshAfterActivation() {
    notifySessionRepositoriesChanged(workspaceId);
    const current = await loadWorkspace();
    setSnapshot(current.snapshot);
    setHistory(current.history);
    setEdit(editFrom(current.snapshot, edit?.input.kind));
    setPreview(null);
    setConflict(false);
  }

  async function publish() {
    const draft = snapshot?.draft;
    if (!draft || dirty || locked || !draftTests.eligible) return;
    const error = await run("publish", async () => {
      await fetchFactoryEditor(
        `${api}/settings`,
        z.object({ snapshot: z.object({ activationNumber: z.number() }) }),
        factoryEditorPost({
          action: "publish",
          expectedActivationNumber: snapshot.activationNumber,
          draftId: draft.id,
        }),
      );
      await refreshAfterActivation();
      setFeedback({
        kind: "success",
        text: draft.source.modelRouting
          ? "Draft published in shadow mode."
          : "Draft published for new sessions.",
      });
    });
    if (error) draftTests.refresh();
  }

  async function activateReviewedRouting(target: ReviewedRoutingActivationTarget) {
    if (
      !draft?.source.modelRouting ||
      !draft.routingDraftEvidence ||
      draft.routingQualification?.status === "stale" ||
      locked ||
      dirty ||
      !draftTests.eligible ||
      target.activationNumber !== activationNumber ||
      target.draftId !== draft.id ||
      target.digest !== draft.digest
    ) {
      throw new Error(
        "Review the current saved draft and configuration test before activating routing.",
      );
    }
    const error = await run("activate-routing", async () => {
      await fetchFactoryEditor(
        api,
        activationSavedSchema,
        factoryEditorPost({
          action: "activate-routing",
          expectedActivationNumber: target.activationNumber,
          draftId: target.draftId,
          ...(target.canary ? { canary: target.canary } : {}),
        }),
      );
      await refreshAfterActivation();
      setFeedback({
        kind: "success",
        text: target.canary
          ? "Routing canary started for new sessions."
          : "Reviewed routing activated for new sessions.",
      });
    });
    if (error) {
      draftTests.refresh();
      throw error;
    }
  }

  async function selectRevision({
    revisionId,
    activationNumber: activation,
  }: FactoryEditorActivation) {
    await run("select", async () => {
      const document = await readDefinition(editorApi, { revision: revisionId, activation });
      setSelected({ ...document, activationNumber: activation });
      setPreview(null);
    });
  }

  async function loadMore() {
    const before = history?.nextBeforeActivationNumber;
    if (!before) return;
    await run("history", async () => {
      const page = await fetchFactoryEditor(
        `${api}?beforeActivationNumber=${before}`,
        factoryEditorHistoryResponseSchema,
      );
      setHistory((current) =>
        current
          ? {
              ...current,
              activations: [...current.activations, ...page.activations],
              nextBeforeActivationNumber: page.nextBeforeActivationNumber,
            }
          : page,
      );
    });
  }

  async function rollback(
    revisionId: string,
    expectedActivationNumber: number,
    targetActivationNumber: number,
  ) {
    if (
      dirty ||
      locked ||
      restoreHeadChanged ||
      !revisionTests.eligible ||
      selectedRevision !== revisionId ||
      selectedActivationNumber !== targetActivationNumber ||
      expectedActivationNumber !== activationNumber
    ) {
      throw new Error("Review the current test result before activating this revision.");
    }
    const error = await run("rollback", async () => {
      await fetchFactoryEditor(
        api,
        activationSavedSchema,
        factoryEditorPost({
          action: "rollback",
          expectedActivationNumber,
          revisionId,
          targetActivationNumber,
        }),
      );
      await refreshAfterActivation();
      setFeedback({ kind: "success", text: "Selected revision activated for new sessions." });
    });
    if (error) {
      revisionTests.refresh();
      throw error;
    }
  }

  function receiptHref(document: FactoryEditorDocument, test: string) {
    const query =
      document.kind === "draft"
        ? { draft: document.id, test }
        : {
            revision: document.id,
            activation: document.activationNumber,
            restoreFrom:
              document.id === requestedRevision && document.activationNumber === requestedActivation
                ? requestedRestoreFrom
                : undefined,
            test,
          };
    return `${workspaceFactoryDefinitionPath(workspaceSlug, { ...query, factory: factoryId })}#candidate-tests`;
  }

  function resetToLatest(source?: SerialFactoryDefinition) {
    if (!snapshot) return;
    const latest = editFrom(snapshot, edit?.input.kind);
    setEdit(
      source && latest
        ? {
            ...latest,
            input:
              latest.input.kind === "json"
                ? { kind: "json", text: sourceText(source) }
                : { kind: "structured", value: source },
          }
        : latest,
    );
    setPreview(null);
    setDiagnostics([]);
    setFeedback(
      source
        ? {
            kind: "info",
            text: sameDefinitionValue(source, latest?.original)
              ? "You’re up to date with the latest definition."
              : "Reviewed edits applied. Save the draft to share them.",
          }
        : null,
    );
    editControlsRef.current?.focus();
  }

  function useCredentialBinding(id: string) {
    if (!edit || !canUseCredentialBinding) return;
    const value = { ...edit.original, credentialBindingId: id };
    replaceInput(
      edit.input.kind === "structured"
        ? { kind: "structured", value }
        : { kind: "json", text: sourceText(value) },
    );
    setFeedback({ kind: "success", text: "Credential binding added. Save the draft to apply it." });
  }

  return (
    <PageContainer className="max-w-[1240px]">
      <PageHeader
        title="Factory definition"
        description={
          factoryName
            ? `Edit the configuration new sessions use in ${factoryName} and inspect its published revisions.`
            : "Edit the configuration new sessions use and inspect published revisions."
        }
        eyebrow={
          <Link
            className="text-accent underline underline-offset-2"
            href={workspaceSettingsPath(workspaceSlug)}
          >
            Settings
          </Link>
        }
        eyebrowAsPlain
        actions={
          <>
            {factorySelection ? (
              <FactoryDefinitionSwitch
                disabled={busy}
                dirty={dirty}
                onDiscard={() => {
                  if (recoveryKey) recoverableEdits.delete(recoveryKey);
                  resetToLatest();
                }}
                selection={factorySelection}
              />
            ) : null}
            <button
              className="ui-button"
              disabled={busy}
              onClick={() => void reload()}
              ref={reloadButtonRef}
              type="button"
            >
              <ActionButtonLabel
                idle="Reload definition"
                pending={pending === "reload"}
                pendingLabel="Loading…"
              />
            </button>
          </>
        }
        actionsRightOnDesktop
      />
      {!loading && routingDraftEvidence ? (
        <RoutingDraftEvidencePanel
          evidence={routingDraftEvidence}
          factoryId={factoryId}
          workspaceSlug={workspaceSlug}
        />
      ) : null}
      <div className="mb-6 space-y-2">
        <InlineActionMessage message={feedback} />
        {loading ? (
          <p className="type-secondary text-muted" role="status">
            Loading definition…
          </p>
        ) : null}
        {diagnostics.length ? (
          <ul
            aria-label="Validation diagnostics"
            className="list-disc space-y-1 break-words pl-5 text-sm text-danger"
          >
            {diagnostics.map(({ path, message }, index) => (
              <li key={index}>
                {path.length ? <code>{path.join(".")} </code> : null}
                {message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {snapshot ? (
        <div className="grid min-w-0 gap-10 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-8">
            <PageSection anchorId="definition" title="Working definition">
              <div className="ui-sheet space-y-5 p-4 sm:p-5">
                {conflict ? (
                  <div className="space-y-2 rounded-[6px] border border-warning/20 bg-warning-soft p-4">
                    <p className="type-secondary text-foreground">
                      Reload the current definition to review the conflict. Reloading keeps your
                      unsaved edits.
                    </p>
                    <button
                      className="ui-button"
                      disabled={busy}
                      id="draft-conflict"
                      onClick={() => void reload()}
                      ref={conflictReloadRef}
                      type="button"
                    >
                      Load latest for review
                    </button>
                  </div>
                ) : stale && edit ? (
                  <DraftConflictReview
                    busy={busy}
                    input={edit.input}
                    latest={latestSource}
                    onApply={resetToLatest}
                    onDiscard={() => resetToLatest()}
                    original={edit.original}
                  />
                ) : null}
                <dl className="grid gap-3 break-all text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted">Published activation</dt>
                    <dd className="mt-1 font-medium">
                      {snapshot.published ? (
                        <Link
                          className="text-accent underline underline-offset-2"
                          href={workspaceFactoryDefinitionPath(workspaceSlug, {
                            factory: factoryId,
                            revision: snapshot.published.id,
                            activation: snapshot.activationNumber,
                          })}
                          target="_blank"
                          rel="noreferrer"
                          title={snapshot.published.digest}
                        >
                          #{snapshot.activationNumber} · {snapshot.published.digest.slice(0, 12)}
                        </Link>
                      ) : (
                        "None"
                      )}
                    </dd>
                    {snapshot.routingCanary ? (
                      <dd className="mt-1 space-y-1">
                        <p className="text-foreground">
                          Canary active · {snapshot.routingCanary.taskClassSlug} ·{" "}
                          {snapshot.routingCanary.candidateBps / 100}% candidate share
                        </p>
                        <Link
                          className="text-accent underline underline-offset-2"
                          href={`${workspaceAnalyticsPath(workspaceSlug, { factory: history?.factoryId ?? factoryId, routingCanary: snapshot.routingCanary.id })}#routing-canary`}
                          prefetch={false}
                        >
                          View canary outcomes
                        </Link>
                        {snapshot.routingCanaryAlertId ? (
                          <Link
                            className="block text-accent underline underline-offset-2"
                            href={`${workspaceAnalyticsPath(workspaceSlug, {
                              factory: history?.factoryId ?? factoryId,
                              routingCanary: snapshot.routingCanary.id,
                              routingAlert: snapshot.routingCanaryAlertId,
                            })}#routing-canary`}
                            prefetch={false}
                          >
                            Review canary degradation alert
                          </Link>
                        ) : null}
                      </dd>
                    ) : snapshot.routingMode === "active" ? (
                      <dd className="mt-1 text-success">Routing active for new sessions</dd>
                    ) : null}
                  </div>
                  <div>
                    <dt className="text-muted">Saved draft</dt>
                    <dd className="mt-1 font-medium">
                      {snapshot.draft ? (
                        <Link
                          className="text-accent underline underline-offset-2"
                          href={workspaceFactoryDefinitionPath(workspaceSlug, {
                            factory: factoryId,
                            draft: snapshot.draft.id,
                          })}
                          target="_blank"
                          rel="noreferrer"
                          title={snapshot.draft.digest}
                        >
                          {snapshot.draft.digest.slice(0, 12)}
                        </Link>
                      ) : (
                        "None"
                      )}
                    </dd>
                  </div>
                </dl>
                <RoutingQualificationNotice
                  status={snapshot.published?.routingQualification}
                  subject="Published"
                />
                {edit ? (
                  <>
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-3"
                      ref={editControlsRef}
                      tabIndex={-1}
                    >
                      <div
                        aria-label="Editing format"
                        className="flex flex-wrap gap-2"
                        role="group"
                      >
                        <button
                          aria-pressed={edit.input.kind === "structured"}
                          className="ui-button aria-pressed:border-border-strong aria-pressed:bg-control-muted"
                          disabled={busy || (locked && edit.input.kind !== "structured")}
                          onClick={() => void changeMode("structured")}
                          type="button"
                        >
                          Structured
                        </button>
                        <button
                          aria-pressed={edit.input.kind === "json"}
                          className="ui-button aria-pressed:border-border-strong aria-pressed:bg-control-muted"
                          disabled={busy}
                          onClick={() => void changeMode("json")}
                          type="button"
                        >
                          JSON source
                        </button>
                      </div>
                      {dirty ? (
                        <span className="text-xs text-warning" role="status">
                          Unsaved edits
                        </span>
                      ) : null}
                    </div>
                    {edit.input.kind === "structured" ? (
                      <StructuredFactoryDefinitionEditor
                        benchmarksHref={workspaceBenchmarksPath(workspaceSlug, {
                          factory: factoryId,
                        })}
                        disabled={busy}
                        repositories={repositories}
                        referenceOptions={referenceOptions}
                        value={edit.input.value}
                        onChange={(value) => replaceInput({ kind: "structured", value })}
                      />
                    ) : (
                      <label className="block min-w-0 space-y-2 text-sm font-medium">
                        <span>Definition JSON</span>
                        <textarea
                          className="ui-textarea min-h-72 w-full resize-y font-mono text-sm"
                          rows={14}
                          disabled={busy}
                          onChange={(event) =>
                            replaceInput({ kind: "json", text: event.target.value })
                          }
                          spellCheck={false}
                          value={edit.input.text}
                        />
                      </label>
                    )}
                    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
                      <button
                        className="ui-button"
                        disabled={locked}
                        onClick={() => void validate()}
                        type="button"
                      >
                        <ActionButtonLabel
                          idle="Validate and preview"
                          pending={pending === "preview"}
                          pendingLabel="Validating…"
                        />
                      </button>
                      <button
                        className="ui-button-primary"
                        disabled={locked || (!dirty && Boolean(snapshot.draft))}
                        onClick={() => void save()}
                        type="button"
                      >
                        <ActionButtonLabel
                          idle="Save draft"
                          pending={pending === "save"}
                          pendingLabel="Saving…"
                        />
                      </button>
                      {snapshot.draft ? (
                        <button
                          className="ui-button"
                          disabled={locked || dirty || !draftTests.eligible}
                          onClick={() => void publish()}
                          type="button"
                        >
                          <ActionButtonLabel
                            idle={
                              draft?.source.modelRouting
                                ? "Publish in shadow mode"
                                : "Publish draft"
                            }
                            pending={pending === "publish"}
                            pendingLabel="Publishing…"
                          />
                        </button>
                      ) : null}
                      {draft?.source.modelRouting ? (
                        <ReviewedRoutingActivation
                          activationNumber={activationNumber}
                          baselineAvailable={Boolean(snapshot.published && !snapshot.routingCanary)}
                          draft={draft}
                          eligible={
                            !locked &&
                            !dirty &&
                            draftTests.eligible &&
                            draft.routingQualification?.status !== "stale" &&
                            Boolean(draft.routingDraftEvidence)
                          }
                          factoryId={history?.factoryId ?? factoryId}
                          onActivate={activateReviewedRouting}
                          pending={pending === "activate-routing"}
                          restoreFocusRef={reloadButtonRef}
                          testHref={
                            reviewedRoutingTest
                              ? receiptHref(draft, reviewedRoutingTest.id)
                              : undefined
                          }
                          workspaceSlug={workspaceSlug}
                        />
                      ) : null}
                    </div>
                    {conflict || stale ? (
                      <p className="type-secondary text-warning">
                        <a className="underline underline-offset-2" href="#draft-conflict">
                          {conflict ? "Load the latest definition" : "Review draft changes"}
                        </a>{" "}
                        before saving or validating.
                      </p>
                    ) : null}
                    <RoutingQualificationNotice
                      status={draft?.routingQualification}
                      subject="Draft"
                    />
                    {draft?.source.modelRouting &&
                    !draft.routingDraftEvidence &&
                    draft.routingQualification?.status !== "stale" ? (
                      <p className="type-secondary text-muted">
                        Apply a qualified benchmark finding before activating routing.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="type-secondary text-muted">
                    Add an active pipeline with at least one stage and connect a repository to this
                    factory to create the first draft.
                  </p>
                )}
              </div>
            </PageSection>
            <FactoryRoutingPreview
              key={draft ? `${draft.id}:${draft.digest}:${activationNumber}` : "no-routing-draft"}
              activationNumber={activationNumber}
              api={api}
              disabled={locked || dirty}
              disabledReason={
                conflict || stale
                  ? "Reload the definition before previewing routing."
                  : dirty
                    ? "Save draft changes before previewing routing."
                    : null
              }
              draft={draft}
            />
            {draft ? (
              <div
                className="scroll-mt-8"
                id={useHistoricalTestAnchor ? undefined : "candidate-tests"}
              >
                <CandidateTestPanel
                  {...draftTests.panel}
                  activationNumber={activationNumber}
                  target={{ kind: "draft", id: draft.id, digest: draft.digest }}
                  purpose="publish"
                  allowStart={!locked && !dirty && draftTests.canTest}
                  disableReason={
                    conflictReason ??
                    (dirty ? "Save your changes before testing the new draft." : null)
                  }
                  evidenceHref={(test) => receiptHref(draft, test)}
                />
              </div>
            ) : null}
            <FactoryScorerBindings
              factoryId={history?.factoryId ?? factoryId}
              workspaceSlug={workspaceSlug}
              options={referenceOptions?.scorers ?? []}
              definitions={[
                { label: "Active definition", content: snapshot.published },
                { label: "Saved draft", content: snapshot.draft },
                { label: "Validated edit", content: preview },
                {
                  label: selected?.kind === "draft" ? "Historical draft" : "Historical definition",
                  content:
                    selected?.id !== snapshot.published?.id && selected?.id !== snapshot.draft?.id
                      ? selected
                      : null,
                },
              ]}
            />
            <PageSection anchorId="semantic-diff" title="Semantic diff">
              {selected ? (
                <button
                  className="ui-button mb-3"
                  disabled={busy}
                  onClick={() => setSelected(null)}
                  type="button"
                >
                  Clear revision selection
                </button>
              ) : null}
              {preview || snapshot.draft || selected ? (
                <FactorySemanticDiff
                  before={snapshot.published?.bundle ?? null}
                  after={(preview ?? selected ?? snapshot.draft)?.bundle ?? null}
                  afterLabel={
                    preview ? "Validated edit" : selected ? "Selected definition" : "Saved draft"
                  }
                />
              ) : (
                <p className="type-secondary text-muted">
                  Validate an edit or select a revision to compare it with the published definition.
                </p>
              )}
            </PageSection>
            <FactoryMcpManifestInspector
              manifest={manifestTarget?.bundle.mcpManifest}
              tagline={
                manifestTarget
                  ? `${manifestTargetLabel} · ${manifestTarget.digest.slice(0, 12)}`
                  : undefined
              }
            />
            {capabilityTarget ? (
              <FactoryExecutionProfilePanel
                api={api}
                refresh={profileRefresh}
                target={capabilityTarget}
              />
            ) : null}
            {capabilityTarget?.bundle.executionGrant && history ? (
              <PageSection anchorId="service-credentials" title="Service credentials">
                {credentialScope ? (
                  <ServiceCredentialsPanel
                    key={capabilityTarget.id}
                    endpoint={`/api/workspaces/${workspaceId}/factories/${history.factoryId}/secret-bindings`}
                    scope={credentialScope}
                    workspaceSlug={workspaceSlug}
                    canUseBinding={canUseCredentialBinding}
                    onChanged={refreshProfile}
                    onUseBinding={useCredentialBinding}
                  />
                ) : (
                  <p className="type-secondary text-muted">
                    Save an implementation agent revision and a supported model to attach a service
                    credential.
                  </p>
                )}
              </PageSection>
            ) : null}
            {capabilityTarget ? (
              <PageSection
                anchorId="capability-check"
                title="Sandbox capability"
                tagline={`Check the ${selected ? "selected" : "current"} ${capabilityTarget.kind} · ${capabilityTarget.digest.slice(0, 12)}`}
              >
                <div className="ui-sheet p-4 sm:p-5">
                  <FactoryCapabilityProbe
                    key={capabilityTarget.id}
                    canManage={!busy}
                    definitionEndpoint={`${api}/capability-check`}
                    onCheckChange={refreshProfileAfterCheck}
                    target={capabilityTarget}
                    repositories={repositories}
                    sandboxConnected={snapshot.readySandboxProviders.includes(
                      capabilityTarget.bundle.sandboxProvider,
                    )}
                    setFlashMessage={(message) => {
                      setFeedback(message);
                      if (message?.kind === "success") {
                        draftTests.refresh();
                        revisionTests.refresh();
                      }
                    }}
                    workspaceId={workspaceId}
                  />
                </div>
              </PageSection>
            ) : null}
          </div>
          <FactoryRevisionHistory
            activations={history?.activations ?? []}
            activeActivationNumber={snapshot.activationNumber}
            activeRevisionId={snapshot.published?.id ?? null}
            selectedRevisionId={selectedRevision}
            selectedActivationNumber={selectedActivationNumber}
            selectedDocument={selected}
            nextBeforeActivationNumber={history?.nextBeforeActivationNumber ?? null}
            busy={busy}
            canManage={!dirty && !stale && !conflict}
            activationEligible={!restoreHeadChanged && revisionTests.eligible}
            candidateTests={
              historyCandidate ? (
                <div
                  className="scroll-mt-8"
                  id={!draft || useHistoricalTestAnchor ? "candidate-tests" : undefined}
                >
                  {restoreConflict ? (
                    <p className="ui-sheet type-secondary mb-3 p-4 text-muted" role="status">
                      {restoreConflict}
                    </p>
                  ) : null}
                  <CandidateTestPanel
                    {...revisionTests.panel}
                    activationNumber={activationNumber}
                    target={{
                      kind: historyCandidate.kind,
                      id: historyCandidate.id,
                      digest: historyCandidate.digest,
                    }}
                    purpose={isRollbackCandidate ? "rollback" : "history"}
                    allowStart={!restoreHeadChanged && !locked && !dirty && revisionTests.canTest}
                    disableReason={
                      conflictReason ??
                      (dirty && isRollbackCandidate
                        ? "Save or discard your edits before testing a revision."
                        : null)
                    }
                    evidenceHref={(test) => receiptHref(historyCandidate, test)}
                  />
                </div>
              ) : null
            }
            onSelect={(activation) => void selectRevision(activation)}
            onLoadMore={() => void loadMore()}
            onRollback={rollback}
            revisionHref={(revision, activation) =>
              workspaceFactoryDefinitionPath(workspaceSlug, {
                revision,
                activation,
                factory: factoryId,
              })
            }
            sourceDraftHref={(draft) =>
              workspaceFactoryDefinitionPath(workspaceSlug, { draft, factory: factoryId })
            }
          />
        </div>
      ) : null}
    </PageContainer>
  );
}
