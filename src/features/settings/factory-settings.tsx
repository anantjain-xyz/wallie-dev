"use client";

import Link from "next/link";

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { useCandidateTests } from "@/features/factory-definition/use-candidate-tests";
import { useBlockPersonalSettings } from "@/features/settings/personal-settings-navigation";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { readResponseJson } from "@/features/settings/use-api-action";
import {
  factorySettingsResponseSchema,
  type FactorySettingsCommand,
  type FactorySettingsPatch,
  type FactorySettingsSnapshot,
} from "@/lib/factory-definitions/settings-contracts";

type Phase = "loading" | "legacy" | "ready" | "error";
const formSections = [
  "pipeline",
  "agent",
  "sandboxProvider",
  "executionPolicy",
  "deliveryPolicy",
] as const;
type FormSection = (typeof formSections)[number];

type DirtySection = {
  displayed: FactorySettingsSnapshot;
  saveAgainst: FactorySettingsSnapshot;
};

type DirtySections = Readonly<Partial<Record<FormSection, DirtySection>>>;

type FactorySettings = {
  phase: Phase;
  snapshot: FactorySettingsSnapshot | null;
  canManage: boolean;
  busy: boolean;
  conflict: string | null;
  error: string | null;
  canPublish: boolean;
  publishEligibility: string | null;
  dirtySections: DirtySections;
  setDirty: (section: FormSection, displayed: FactorySettingsSnapshot | null) => void;
  reload: () => Promise<void>;
  save: (
    baseline: FactorySettingsSnapshot,
    patch: FactorySettingsPatch,
  ) => Promise<FactorySettingsSnapshot>;
  publish: (baseline: FactorySettingsSnapshot) => Promise<void>;
};

const FactorySettingsContext = createContext<FactorySettings | null>(null);

export function useFactorySettings() {
  return useContext(FactorySettingsContext);
}

async function readFactorySettings(response: Response) {
  const parsed = factorySettingsResponseSchema.safeParse(await readResponseJson(response));
  if (!parsed.success) throw new Error("The server returned invalid factory settings.");
  return parsed.data.snapshot;
}

export function FactorySettingsProvider({
  canManage,
  children,
  workspaceId,
}: {
  canManage: boolean;
  children: ReactNode;
  workspaceId: string;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [snapshot, setSnapshot] = useState<FactorySettingsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirtySections, setDirtySections] = useState<DirtySections>({});
  const inFlight = useRef(false);
  const api = `/api/workspaces/${workspaceId}/factory-definition`;
  const url = `${api}/settings`;
  const draft = canManage ? snapshot?.draft : null;
  const candidateTests = useCandidateTests({
    api,
    target: draft ? { ...draft, kind: "draft" } : null,
    activationNumber: snapshot?.activationNumber ?? 0,
    active: canManage,
  });
  const hasDirtySections = Object.keys(dirtySections).length > 0;
  useBlockPersonalSettings(busy || hasDirtySections);
  const canPublish = candidateTests.eligible && !hasDirtySections && !conflict;
  let publishEligibility: string | null = null;
  if (draft && !conflict) {
    if (hasDirtySections) publishEligibility = "Save or discard your edits before publishing.";
    else if (canPublish) publishEligibility = "Ready to publish this draft.";
    else if (candidateTests.panel.error) {
      publishEligibility =
        "Could not verify publication eligibility. Reload or review the configuration tests.";
    } else if (candidateTests.panel.eligibility) {
      const { activationNumber, reason } = candidateTests.panel.eligibility;
      publishEligibility =
        activationNumber === snapshot?.activationNumber
          ? (reason ?? "A current passing test is required to publish this draft.")
          : "The active factory revision changed. Reload configuration before publishing.";
    } else {
      publishEligibility = "Checking publication eligibility…";
    }
  }

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await readFactorySettings(await fetch(url, { cache: "no-store", signal }));
        if (signal?.aborted) return;
        setSnapshot(next);
        setPhase(next ? "ready" : "legacy");
        setConflict(null);
        setError(null);
      } catch (caught) {
        if (signal?.aborted) return;
        setPhase((current) => (current === "ready" ? current : "error"));
        setError(
          caught instanceof Error ? caught.message : "Factory settings could not be loaded.",
        );
      }
    },
    [url],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const setDirty = useCallback(
    (section: FormSection, displayed: FactorySettingsSnapshot | null) => {
      setDirtySections((current) => {
        if (Boolean(current[section]) === Boolean(displayed)) return current;
        const next = { ...current };
        if (displayed) next[section] = { displayed, saveAgainst: displayed };
        else delete next[section];
        return next;
      });
    },
    [],
  );

  async function reload() {
    if (inFlight.current || phase === "loading") return;
    inFlight.current = true;
    setBusy(true);
    try {
      await load();
      candidateTests.refresh();
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function mutate(body: FactorySettingsCommand, submittedDraft?: FactorySettingsSnapshot) {
    if (!canManage || phase !== "ready" || inFlight.current) {
      throw new Error("Factory settings are busy. Try again.");
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 409) {
        const message = "Factory settings changed. Reload to review the latest draft.";
        setConflict(message);
        throw new Error(message);
      }
      const next = await readFactorySettings(response);
      if (!next) throw new Error("The saved factory settings were missing from the response.");
      setSnapshot(next);
      if (submittedDraft) {
        setDirtySections((current) => advanceUnchangedSections(current, submittedDraft, next));
      }
      setConflict(null);
      return next;
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  function save(baseline: FactorySettingsSnapshot, patch: FactorySettingsPatch) {
    return mutate(
      {
        action: "save",
        expectedActivationNumber: baseline.activationNumber,
        expectedDraftId: baseline.draft?.id ?? null,
        patch,
      },
      baseline,
    );
  }

  async function publish(baseline: FactorySettingsSnapshot) {
    if (!baseline.draft || !canPublish) return;
    try {
      await mutate({
        action: "publish",
        expectedActivationNumber: baseline.activationNumber,
        draftId: baseline.draft.id,
      });
    } catch (caught) {
      candidateTests.refresh();
      setError(caught instanceof Error ? caught.message : "The draft could not be published.");
    }
  }

  return (
    <FactorySettingsContext.Provider
      value={{
        phase,
        snapshot,
        canManage,
        busy,
        conflict,
        error,
        canPublish,
        publishEligibility,
        dirtySections,
        setDirty,
        reload,
        save,
        publish,
      }}
    >
      {children}
    </FactorySettingsContext.Provider>
  );
}

export function FactorySettingsPanel({ editorHref }: { editorHref?: string }) {
  const settings = useFactorySettings();
  const publishEligibilityId = useId();
  if (!settings || (settings.phase === "legacy" && !editorHref)) return null;

  const {
    phase,
    snapshot,
    canManage,
    busy,
    conflict,
    error,
    canPublish,
    publishEligibility,
    dirtySections,
    reload,
    publish,
  } = settings;
  const message = conflict ?? error;
  const draft = snapshot?.draft;
  const published = snapshot?.published;
  const needsTest = Boolean(draft) && !canPublish;
  return (
    <>
      {phase === "loading" ? (
        <p className="text-[13px] text-muted" role="status">
          Loading factory configuration…
        </p>
      ) : (
        <div className="space-y-3 rounded-[6px] border border-border bg-sheet p-4">
          {snapshot ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]" role="status">
              <p>
                <span className="font-semibold">Published</span>{" "}
                {published ? `#${snapshot.activationNumber}` : "No version published"}
              </p>
              {canManage ? (
                <p>
                  <span className="font-semibold">Draft</span> {draft ? "Saved" : "No saved draft"}
                </p>
              ) : null}
              {Object.keys(dirtySections).length ? (
                <p className="text-warning">Unsaved edits</p>
              ) : null}
            </div>
          ) : null}
          <InlineActionMessage message={message ? { kind: "error", text: message } : null} />
          {publishEligibility && (
            <p className="text-[13px] text-muted" id={publishEligibilityId} role="status">
              {publishEligibility}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {phase !== "legacy" ? (
              <button
                className="ui-button"
                disabled={busy}
                onClick={() => void reload()}
                type="button"
              >
                Reload configuration
              </button>
            ) : null}
            {canManage && editorHref ? (
              <Link
                className="ui-button"
                href={needsTest ? `${editorHref}#candidate-tests` : editorHref}
              >
                {needsTest ? "Review configuration tests" : "Open definition editor"}
              </Link>
            ) : null}
            {canManage && draft && snapshot ? (
              <button
                aria-describedby={publishEligibility ? publishEligibilityId : undefined}
                className="ui-button-primary"
                disabled={busy || !canPublish}
                onClick={() => void publish(snapshot)}
                type="button"
              >
                <ActionButtonLabel idle="Publish draft" pending={busy} pendingLabel="Working…" />
              </button>
            ) : null}
          </div>
          {published || (canManage && draft) ? (
            <details className="type-secondary text-muted">
              <summary className="w-fit cursor-pointer">Revision details</summary>
              {published ? (
                <p className="mt-2 [overflow-wrap:anywhere]">
                  Published digest: <code>{published.digest}</code>
                </p>
              ) : null}
              {canManage && draft ? (
                <p className="mt-1 [overflow-wrap:anywhere]">
                  Draft digest: <code>{draft.digest}</code>
                </p>
              ) : null}
            </details>
          ) : null}
        </div>
      )}
    </>
  );
}

export type FactorySettingsFormRevision = {
  snapshot: FactorySettingsSnapshot;
  busy: boolean;
  save: (patch: FactorySettingsPatch) => Promise<FactorySettingsSnapshot>;
  setDirty: (dirty: boolean) => void;
};

function factoryScopeKey(snapshot: FactorySettingsSnapshot) {
  return `${snapshot.repositoryId}:${snapshot.pipeline.id}:${snapshot.activationNumber}:${snapshot.published?.id ?? "unpublished"}`;
}

function revisionKey(snapshot: FactorySettingsSnapshot) {
  return `${factoryScopeKey(snapshot)}:${snapshot.draft?.id ?? ""}`;
}

function advanceUnchangedSections(
  dirtySections: DirtySections,
  submitted: FactorySettingsSnapshot,
  accepted: FactorySettingsSnapshot,
) {
  if (factoryScopeKey(submitted) !== factoryScopeKey(accepted)) return dirtySections;

  let updated: Partial<Record<FormSection, DirtySection>> | undefined;
  const submittedKey = revisionKey(submitted);
  for (const section of formSections) {
    const edit = dirtySections[section];
    if (!edit || revisionKey(edit.saveAgainst) !== submittedKey) continue;

    const displayedValue = JSON.stringify(edit.displayed[section]);
    if (
      displayedValue !== JSON.stringify(submitted[section]) ||
      displayedValue !== JSON.stringify(accepted[section])
    ) {
      continue;
    }

    // Keep the form mounted on its displayed snapshot while advancing its write version.
    updated ??= { ...dirtySections };
    updated[section] = { displayed: edit.displayed, saveAgainst: accepted };
  }
  return updated ?? dirtySections;
}

export function useFactorySettingsForm(section: FormSection) {
  const settings = useFactorySettings();
  const latest = settings?.snapshot;
  const reportDirty = settings?.setDirty;
  const edit = settings?.dirtySections[section];
  const displayed = edit?.displayed ?? latest;
  const saveAgainst = edit?.saveAgainst ?? latest;

  const setDirty = useCallback(
    (dirty: boolean) => {
      reportDirty?.(section, dirty ? (displayed ?? null) : null);
    },
    [displayed, reportDirty, section],
  );

  useEffect(() => () => reportDirty?.(section, null), [reportDirty, section]);

  const blocked = Boolean(settings && settings.phase !== "legacy" && !displayed);
  const stale = Boolean(edit && (!latest || revisionKey(latest) !== revisionKey(edit.saveAgainst)));
  const revision: FactorySettingsFormRevision | null =
    settings && displayed && saveAgainst
      ? {
          snapshot: displayed,
          busy: settings.busy,
          save: (patch) => settings.save(saveAgainst, patch),
          setDirty,
        }
      : null;
  return { blocked, revision, stale };
}

const sectionLabels: Record<FormSection, string> = {
  pipeline: "pipeline",
  agent: "coding agent",
  sandboxProvider: "sandbox provider",
  executionPolicy: "execution policy",
  deliveryPolicy: "delivery policy",
};

export function FactorySettingsFormConflict({
  discard,
  section,
}: {
  discard: () => void;
  section: FormSection;
}) {
  const label = sectionLabels[section];
  return (
    <div
      className="my-3 flex flex-wrap items-center gap-3 rounded-[6px] border border-warning/20 bg-warning-soft px-3 py-2 text-[13px] text-warning"
      role="status"
    >
      <p>The {label} has unsaved edits from an earlier version.</p>
      <button className="ui-button" onClick={discard} type="button">
        Discard {label} edits
      </button>
    </div>
  );
}

export function FactorySettingsForm({
  children,
  section,
}: {
  children: (revision: FactorySettingsFormRevision | null) => ReactNode;
  section: FormSection;
}) {
  const { blocked, revision, stale } = useFactorySettingsForm(section);
  if (blocked) return null;
  if (!revision) return children(null);
  return (
    <>
      {stale ? (
        <FactorySettingsFormConflict discard={() => revision.setDirty(false)} section={section} />
      ) : null}
      <Fragment key={revisionKey(revision.snapshot)}>{children(revision)}</Fragment>
    </>
  );
}
