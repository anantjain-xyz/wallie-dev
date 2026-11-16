"use client";

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { InlineActionMessage, Section } from "@/features/settings/settings-ui";
import { readResponseJson } from "@/features/settings/use-api-action";
import {
  factorySettingsResponseSchema,
  type FactorySettingsCommand,
  type FactorySettingsPatch,
  type FactorySettingsSnapshot,
} from "@/lib/factory-definitions/settings-contracts";

type Phase = "loading" | "legacy" | "ready" | "error";
type FormSection = "pipeline" | "agent" | "sandboxProvider" | "executionPolicy" | "deliveryPolicy";

type FactorySettings = {
  phase: Phase;
  snapshot: FactorySettingsSnapshot | null;
  canManage: boolean;
  busy: boolean;
  conflict: string | null;
  error: string | null;
  dirtySections: ReadonlySet<FormSection>;
  setDirty: (section: FormSection, dirty: boolean) => void;
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
  const [dirtySections, setDirtySections] = useState<ReadonlySet<FormSection>>(() => new Set());
  const inFlight = useRef(false);
  const url = `/api/workspaces/${workspaceId}/factory-definition/settings`;

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

  const setDirty = useCallback((section: FormSection, dirty: boolean) => {
    setDirtySections((current) => {
      if (current.has(section) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(section);
      else next.delete(section);
      return next;
    });
  }, []);

  async function reload() {
    if (inFlight.current || phase === "loading") return;
    inFlight.current = true;
    setBusy(true);
    try {
      await load();
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  async function mutate(body: FactorySettingsCommand) {
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
      setConflict(null);
      return next;
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  function save(baseline: FactorySettingsSnapshot, patch: FactorySettingsPatch) {
    return mutate({
      action: "save",
      expectedActivationNumber: baseline.activationNumber,
      expectedDraftId: baseline.draft?.id ?? null,
      patch,
    });
  }

  async function publish(baseline: FactorySettingsSnapshot) {
    if (!baseline.draft || dirtySections.size) return;
    try {
      await mutate({
        action: "publish",
        expectedActivationNumber: baseline.activationNumber,
        draftId: baseline.draft.id,
      });
    } catch (caught) {
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

export function FactorySettingsPanel() {
  const settings = useFactorySettings();
  if (!settings || settings.phase === "legacy") return null;

  const { phase, snapshot, canManage, busy, conflict, error, dirtySections, reload, publish } =
    settings;
  const message = conflict ?? error;
  const draft = snapshot?.draft;
  const published = snapshot?.published;
  return (
    <Section
      anchorId="factory-configuration"
      title="Factory configuration"
      tagline="Save changes to a shared draft. Publishing sets the configuration for new sessions."
    >
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
                {published ? (
                  <>
                    #{snapshot.activationNumber} ·{" "}
                    <code title={published.digest}>{published.digest.slice(0, 12)}</code>
                  </>
                ) : (
                  "No version published"
                )}
              </p>
              {canManage ? (
                <p>
                  <span className="font-semibold">Draft</span>{" "}
                  {draft ? (
                    <code title={draft.digest}>{draft.digest.slice(0, 12)}</code>
                  ) : (
                    "No saved draft"
                  )}
                </p>
              ) : null}
              {dirtySections.size ? <p className="text-warning">Unsaved edits</p> : null}
            </div>
          ) : null}
          <InlineActionMessage message={message ? { kind: "error", text: message } : null} />
          <div className="flex flex-wrap gap-3">
            <button
              className="ui-button"
              disabled={busy}
              onClick={() => void reload()}
              type="button"
            >
              Reload configuration
            </button>
            {canManage && draft && snapshot ? (
              <button
                className="ui-button-primary"
                disabled={busy || Boolean(conflict) || dirtySections.size > 0}
                onClick={() => void publish(snapshot)}
                type="button"
              >
                <ActionButtonLabel idle="Publish draft" pending={busy} pendingLabel="Working…" />
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Section>
  );
}

export type FactorySettingsFormRevision = {
  snapshot: FactorySettingsSnapshot;
  busy: boolean;
  save: (patch: FactorySettingsPatch) => Promise<FactorySettingsSnapshot>;
  setDirty: (dirty: boolean) => void;
};

function revisionKey(snapshot: FactorySettingsSnapshot) {
  return `${snapshot.repositoryId}:${snapshot.activationNumber}:${snapshot.draft?.id ?? snapshot.published?.id ?? "unpublished"}`;
}

export function useFactorySettingsForm(section: FormSection) {
  const settings = useFactorySettings();
  const latest = settings?.snapshot;
  const reportDirty = settings?.setDirty;
  const [dirtyBaseline, setDirtyBaseline] = useState<FactorySettingsSnapshot | null>(null);
  const baseline = dirtyBaseline ?? latest;

  const setDirty = useCallback(
    (dirty: boolean) => {
      setDirtyBaseline(dirty ? (baseline ?? null) : null);
      reportDirty?.(section, dirty);
    },
    [baseline, reportDirty, section],
  );

  useEffect(() => () => reportDirty?.(section, false), [reportDirty, section]);

  const blocked = Boolean(settings && settings.phase !== "legacy" && !baseline);
  const stale = Boolean(
    dirtyBaseline && (!latest || revisionKey(latest) !== revisionKey(dirtyBaseline)),
  );
  const revision: FactorySettingsFormRevision | null =
    settings && baseline
      ? {
          snapshot: baseline,
          busy: settings.busy,
          save: (patch) => settings.save(baseline, patch),
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
