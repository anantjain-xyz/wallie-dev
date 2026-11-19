"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { FactoryCapabilityProbe } from "@/features/factory-definition/capability-probe";
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
import { FactoryMcpManifestInspector } from "@/features/factory-definition/mcp-manifest-inspector";
import { FactoryRevisionHistory } from "@/features/factory-definition/revision-history";
import { FactorySemanticDiff } from "@/features/factory-definition/semantic-diff";
import { ServiceCredentialsPanel } from "@/features/factory-definition/service-credentials-panel";
import { StructuredFactoryDefinitionEditor } from "@/features/factory-definition/structured-editor";
import { useCandidateTests } from "@/features/factory-definition/use-candidate-tests";
import type { CapabilityRepository } from "@/features/settings/sandbox-capability-section";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { parseOpenCodeModelId } from "@/lib/agent-config/contracts";
import {
  factoryEditorDocumentResponseSchema,
  factoryEditorHistoryResponseSchema,
  factoryEditorPreviewResponseSchema,
  factoryEditorSnapshotResponseSchema,
  type FactoryEditorContent,
  type FactoryEditorDocument,
  type FactoryEditorSnapshot,
} from "@/lib/factory-definitions/editor-contracts";
import type { SerialFactoryDefinition } from "@/lib/factory-definitions/schema";
import type { FactorySecretBindingScope } from "@/lib/factory-secret-bindings/contracts";
import { workspaceFactoryDefinitionPath, workspaceSettingsPath } from "@/lib/routes";

type Selection = ({ revision: string } | { draft: string }) & { test?: string };
type Input =
  | { kind: "structured"; value: SerialFactoryDefinition }
  | { kind: "json"; text: string };
type Edit = {
  input: Input;
  original: SerialFactoryDefinition;
  activationNumber: number;
  draftId: string | null;
};
type Operation = "reload" | "preview" | "save" | "publish" | "select" | "history" | "rollback";
const activationSavedSchema = z.object({ activation: z.object({ revisionId: z.string().uuid() }) });

function sourceText(source: SerialFactoryDefinition) {
  return JSON.stringify(source, null, 2);
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
  mode: Input["kind"] = "structured",
): Edit | null {
  const original = (snapshot.draft ?? snapshot.published ?? snapshot.baseline)?.source;
  if (!original) return null;
  return {
    original,
    input:
      mode === "structured"
        ? { kind: "structured", value: original }
        : { kind: "json", text: sourceText(original) },
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
  return fetchFactoryEditor(`${endpoint}?${query}`, factoryEditorDocumentResponseSchema, {
    signal,
  }).then(({ document }) => document);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Could not update the factory definition.";
}

export function FactoryDefinitionEditor({
  workspaceId,
  workspaceSlug,
  selection,
  repositories,
}: {
  workspaceId: string;
  workspaceSlug: string;
  selection: Selection | null;
  repositories: readonly CapabilityRepository[];
}) {
  const api = `/api/workspaces/${workspaceId}/factory-definition`;
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
  const scrolledReceiptUrl = useRef<string | null>(null);
  const dirty = edit ? editChanged(edit) : false;
  const stale =
    edit !== null &&
    snapshot !== null &&
    (edit.activationNumber !== snapshot.activationNumber ||
      edit.draftId !== (snapshot.draft?.id ?? null));
  const busy = loading || pending !== null;
  const locked = busy || conflict || stale;
  const conflictReason = stale
    ? "Review the latest definition before testing."
    : conflict
      ? "Reload the definition before testing."
      : null;
  const selectedRevision = selected?.kind === "revision" ? selected.id : null;
  const draft = snapshot?.draft ?? null;
  const selectedMatchesDraft =
    draft !== null && selected?.kind === "draft" && selected.id === draft.id;
  const historyCandidate = selectedMatchesDraft ? null : selected;
  const isRollbackCandidate = Boolean(
    selectedRevision && snapshot?.published && selectedRevision !== snapshot.published.id,
  );
  const activationNumber = snapshot?.activationNumber ?? 0;
  const requestedDraft = selection && "draft" in selection ? selection.draft : null;
  const requestedRevision = selection && "revision" in selection ? selection.revision : null;
  const draftTests = useCandidateTests({
    api,
    target: draft,
    activationNumber,
    active: true,
    initialTestId: draft && draft.id === requestedDraft ? selection?.test : undefined,
  });
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
  const anchorCandidate =
    historyCandidate && selection?.test ? historyCandidate : (draft ?? historyCandidate);
  const anchorReady =
    Boolean(anchorCandidate) &&
    (!selection?.test || anchorCandidate?.id === (requestedRevision ?? requestedDraft));

  useEffect(() => {
    const { hash, href } = window.location;
    if (!anchorReady || hash !== "#candidate-tests" || scrolledReceiptUrl.current === href) return;
    const anchor = document.getElementById("candidate-tests");
    if (!anchor) return;
    anchor.scrollIntoView?.({ block: "start" });
    scrolledReceiptUrl.current = href;
  }, [anchorReady, requestedDraft, requestedRevision, selection?.test]);

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
        setEdit(editFrom(current.snapshot));
        const target = requestedRevision
          ? { revision: requestedRevision }
          : requestedDraft
            ? { draft: requestedDraft }
            : null;
        if (target) {
          const document = await readDefinition(editorApi, target, signal);
          if (!signal.aborted) setSelected(document);
        }
      } catch (error) {
        if (!signal.aborted) setFeedback({ kind: "error", text: errorText(error) });
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [editorApi, loadWorkspace, requestedDraft, requestedRevision]);

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
        if (error.status === 409) setConflict(true);
        setDiagnostics(error.diagnostics);
      }
      setFeedback({ kind: "error", text: errorText(error) });
      return error;
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  function replaceInput(input: Input) {
    setEdit((current) => (current ? { ...current, input } : current));
    setPreview(null);
    setDiagnostics([]);
    setFeedback(null);
  }

  async function reload() {
    await run("reload", async () => {
      const current = await loadWorkspace();
      setSnapshot(current.snapshot);
      setHistory(current.history);
      setPreview(null);
      setConflict(false);
      if (!dirty) setEdit(editFrom(current.snapshot, edit?.input.kind));
      draftTests.refresh();
      revisionTests.refresh();
      refreshProfile();
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

  async function changeMode(mode: Input["kind"]) {
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
      setFeedback({ kind: "success", text: "Draft published for new sessions." });
    });
    if (error) draftTests.refresh();
  }

  async function selectRevision(revision: string) {
    await run("select", async () => {
      setSelected(await readDefinition(editorApi, { revision }));
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

  async function rollback(revisionId: string, expectedActivationNumber: number) {
    if (
      dirty ||
      locked ||
      !revisionTests.eligible ||
      selectedRevision !== revisionId ||
      expectedActivationNumber !== activationNumber
    ) {
      throw new Error("Review the current test result before activating this revision.");
    }
    const error = await run("rollback", async () => {
      await fetchFactoryEditor(
        api,
        activationSavedSchema,
        factoryEditorPost({ action: "rollback", expectedActivationNumber, revisionId }),
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
      document.kind === "draft" ? { draft: document.id, test } : { revision: document.id, test };
    return `${workspaceFactoryDefinitionPath(workspaceSlug, query)}#candidate-tests`;
  }

  function resetToLatest(keepEdits: boolean) {
    if (!snapshot) return;
    const latest = editFrom(snapshot, edit?.input.kind);
    setEdit(keepEdits && edit && latest ? { ...latest, input: edit.input } : latest);
    setPreview(null);
    setDiagnostics([]);
    setFeedback(null);
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
        description="Edit the configuration new sessions use and inspect the revisions this workspace has published."
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
          <button className="ui-button" disabled={busy} onClick={() => void reload()} type="button">
            <ActionButtonLabel
              idle="Reload definition"
              pending={pending === "reload"}
              pendingLabel="Loading…"
            />
          </button>
        }
      />
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
        {conflict && !stale ? (
          <p className="type-secondary text-warning" role="status">
            Reload the current definition to review the conflict.
          </p>
        ) : null}
        {stale ? (
          <div className="space-y-3 rounded-[6px] border border-warning/20 bg-warning-soft p-4">
            <p className="text-sm text-foreground">
              The current draft or activation changed. Your edits are still here. Review the latest
              version before applying them.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                className="ui-button"
                disabled={busy}
                onClick={() => resetToLatest(false)}
                type="button"
              >
                Discard edits
              </button>
              <button
                className="ui-button"
                disabled={busy}
                onClick={() => resetToLatest(true)}
                type="button"
              >
                Apply edits to latest draft
              </button>
            </div>
          </div>
        ) : null}
      </div>
      {snapshot ? (
        <div className="grid min-w-0 gap-10 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-8">
            <PageSection anchorId="definition" title="Working definition">
              <div className="ui-sheet space-y-5 p-4 sm:p-5">
                <dl className="grid gap-3 break-all text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted">Published activation</dt>
                    <dd className="mt-1 font-medium">
                      {snapshot.published ? (
                        <Link
                          className="text-accent underline underline-offset-2"
                          href={workspaceFactoryDefinitionPath(workspaceSlug, {
                            revision: snapshot.published.id,
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
                  </div>
                  <div>
                    <dt className="text-muted">Saved draft</dt>
                    <dd className="mt-1 font-medium">
                      {snapshot.draft ? (
                        <Link
                          className="text-accent underline underline-offset-2"
                          href={workspaceFactoryDefinitionPath(workspaceSlug, {
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
                {edit ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-3">
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
                        disabled={busy}
                        repositories={repositories}
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
                            idle="Publish draft"
                            pending={pending === "publish"}
                            pendingLabel="Publishing…"
                          />
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <p className="type-secondary text-muted">
                    Configure a repository and default pipeline in Settings to create the first
                    draft.
                  </p>
                )}
              </div>
            </PageSection>
            {draft ? (
              <div
                className="scroll-mt-8"
                id={historyCandidate && selection?.test ? undefined : "candidate-tests"}
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
            selectedDocument={selected}
            nextBeforeActivationNumber={history?.nextBeforeActivationNumber ?? null}
            busy={busy}
            canManage={!dirty && !stale && !conflict}
            activationEligible={revisionTests.eligible}
            candidateTests={
              historyCandidate ? (
                <div
                  className="scroll-mt-8"
                  id={!draft || selection?.test ? "candidate-tests" : undefined}
                >
                  <CandidateTestPanel
                    {...revisionTests.panel}
                    activationNumber={activationNumber}
                    target={{
                      kind: historyCandidate.kind,
                      id: historyCandidate.id,
                      digest: historyCandidate.digest,
                    }}
                    purpose={isRollbackCandidate ? "rollback" : "history"}
                    allowStart={!locked && !dirty && revisionTests.canTest}
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
            onSelect={(id) => void selectRevision(id)}
            onLoadMore={() => void loadMore()}
            onRollback={rollback}
            revisionHref={(revision) => workspaceFactoryDefinitionPath(workspaceSlug, { revision })}
            sourceDraftHref={(draft) => workspaceFactoryDefinitionPath(workspaceSlug, { draft })}
          />
        </div>
      ) : null}
    </PageContainer>
  );
}
