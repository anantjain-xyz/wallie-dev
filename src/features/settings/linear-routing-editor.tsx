"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";

import { ChevronDownIcon } from "@/components/shared/icons";
import type { PipelineStage } from "@/features/sessions/types";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import { cn } from "@/lib/utils";
import {
  LINEAR_ROUTE_KEYS,
  LINEAR_ROUTE_LABELS,
  type LinearRouteKey,
  type LinearRoutingConfig,
} from "@/lib/linear-routing/contracts";

type LinearRoutingEditorProps = {
  canManage: boolean;
  routing: LinearRoutingConfig;
  setFlashMessage: (message: FlashMessage) => void;
  stages: PipelineStage[];
  workspaceId: string;
};

type LinearRoutingResponse = {
  routing: LinearRoutingConfig;
};

type LinearRoutingDraft = {
  landStageSlug: string;
  monitorStageSlug: string;
  reworkStageSlug: string;
  statusMappings: Record<LinearRouteKey, string>;
};

const LINEAR_ROUTE_ACTIONS: Record<Exclude<LinearRouteKey, "merging" | "rework">, string> = {
  backlog: "Ignore",
  canceled: "Cancel and archive session",
  done: "Archive session",
  in_progress: "Continue current stage",
  in_review: "Pause for review",
  todo: "Start current stage",
};

export function joinStatuses(values: readonly string[]): string {
  return values.join(", ");
}

export function splitStatuses(value: string): string[] {
  const statuses = value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return statuses;
}

export function validateLinearRoutingDraftStages(
  draft: Pick<LinearRoutingDraft, "landStageSlug" | "monitorStageSlug" | "reworkStageSlug">,
  stageOptions: readonly string[],
) {
  if (stageOptions.length === 0) {
    return "Load a default pipeline with at least one stage before saving Linear routing.";
  }

  const available = new Set(stageOptions);
  const requiredRoutes = [
    ["Rework stage", draft.reworkStageSlug],
    ["Land stage", draft.landStageSlug],
  ] as const;

  for (const [label, slug] of requiredRoutes) {
    if (!available.has(slug)) {
      return `${label} must match a current default pipeline stage.`;
    }
  }

  if (draft.monitorStageSlug && !available.has(draft.monitorStageSlug)) {
    return "Monitor stage must match a current default pipeline stage.";
  }

  return null;
}

function routingDraftFromConfig(routing: LinearRoutingConfig): LinearRoutingDraft {
  return {
    landStageSlug: routing.landStageSlug,
    monitorStageSlug: routing.monitorStageSlug ?? "",
    reworkStageSlug: routing.reworkStageSlug,
    statusMappings: Object.fromEntries(
      LINEAR_ROUTE_KEYS.map((key) => [key, joinStatuses(routing.statusMappings[key])]),
    ) as LinearRoutingDraft["statusMappings"],
  };
}

function buildRoutingPayload(draft: LinearRoutingDraft) {
  return {
    landStageSlug: draft.landStageSlug,
    monitorStageSlug: draft.monitorStageSlug.trim() || null,
    reworkStageSlug: draft.reworkStageSlug,
    statusMappings: Object.fromEntries(
      LINEAR_ROUTE_KEYS.map((key) => [key, splitStatuses(draft.statusMappings[key])]),
    ),
  };
}

function actionLabelForRoute(key: LinearRouteKey, draft: LinearRoutingDraft) {
  switch (key) {
    case "merging":
      return `Route to ${draft.landStageSlug} stage`;
    case "rework":
      return `Restart at ${draft.reworkStageSlug} stage`;
    default:
      return LINEAR_ROUTE_ACTIONS[key];
  }
}

export function LinearRoutingEditor({
  canManage,
  routing,
  setFlashMessage,
  stages,
  workspaceId,
}: LinearRoutingEditorProps) {
  return (
    <LinearRoutingControls
      canManage={canManage}
      routing={routing}
      setFlashMessage={setFlashMessage}
      stages={stages}
      workspaceId={workspaceId}
    />
  );
}

export function LinearRoutingControls({
  canManage,
  onSaved,
  routing,
  setFlashMessage,
  stages,
  workspaceId,
}: LinearRoutingEditorProps & {
  onSaved?: (routing: LinearRoutingConfig) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(() => routingDraftFromConfig(routing));

  const stageOptions = useMemo(() => stages.map((stage) => stage.slug), [stages]);

  const saveRouting = useApiAction<LinearRoutingResponse>({
    call: () => {
      const stageError = validateLinearRoutingDraftStages(draft, stageOptions);
      if (stageError) {
        return Response.json({ error: stageError }, { status: 400 });
      }

      return fetch(`/api/workspaces/${workspaceId}/linear-routing`, {
        body: JSON.stringify(buildRoutingPayload(draft)),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });
    },
    errorText: "Linear routing save failed.",
    onSuccess: async (payload) => {
      setDraft(routingDraftFromConfig(payload.routing));
      await onSaved?.(payload.routing);
    },
    setFlashMessage,
    successText: "Linear routing saved.",
  });

  function updateStatus(key: LinearRouteKey, value: string) {
    setDraft((current) => ({
      ...current,
      statusMappings: { ...current.statusMappings, [key]: value },
    }));
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="max-w-2xl space-y-1">
          <h3 className="text-[14px] font-semibold text-foreground">Status mappings</h3>
          <p className="text-[13px] leading-5 text-muted">
            Map the Linear status names your team uses to the Wallie behavior each status should
            trigger.
          </p>
        </div>

        <div className="space-y-2">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)] gap-x-16 text-[11px] font-semibold uppercase text-muted md:grid">
            <span>Linear status names</span>
            <span>Wallie action</span>
          </div>

          <div className="divide-y divide-border border-y border-border">
            {LINEAR_ROUTE_KEYS.map((key) => (
              <div
                className="grid gap-3 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)] md:items-center md:gap-x-16"
                key={key}
              >
                <label className="block min-w-0 space-y-1.5">
                  <span className="block text-[12px] font-semibold uppercase text-muted md:hidden">
                    Linear status names
                  </span>
                  <span className="block text-[13px] font-medium text-foreground">
                    {LINEAR_ROUTE_LABELS[key]}
                  </span>
                  <input
                    aria-label={`${LINEAR_ROUTE_LABELS[key]} Linear status names`}
                    className="ui-input"
                    disabled={!canManage}
                    onChange={(event) => updateStatus(key, event.target.value)}
                    value={draft.statusMappings[key]}
                  />
                </label>

                <div className="min-w-0 md:relative">
                  <div className="flex items-center gap-2 text-[12px] font-semibold uppercase text-muted md:hidden">
                    <span>Wallie action</span>
                    <span aria-hidden="true" className="text-[13px] font-medium normal-case">
                      →
                    </span>
                  </div>
                  <span
                    aria-hidden="true"
                    className="hidden text-[15px] font-medium text-muted md:absolute md:-left-10 md:top-1/2 md:block md:-translate-y-1/2"
                  >
                    →
                  </span>
                  <p className="text-sm font-medium text-foreground">
                    {actionLabelForRoute(key, draft)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-4 border-t border-border pt-6">
        <div className="max-w-2xl space-y-1">
          <h3 className="text-[14px] font-semibold text-foreground">Stage routing</h3>
          <p className="text-[13px] leading-5 text-muted">
            Choose the pipeline stages Wallie should use when Linear moves a session into rework,
            land, or monitor.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <StageSelect
            disabled={!canManage}
            label="Rework stage"
            onChange={(value) => setDraft((current) => ({ ...current, reworkStageSlug: value }))}
            options={stageOptions}
            value={draft.reworkStageSlug}
          />
          <StageSelect
            disabled={!canManage}
            label="Land stage"
            onChange={(value) => setDraft((current) => ({ ...current, landStageSlug: value }))}
            options={stageOptions}
            value={draft.landStageSlug}
          />
          <StageSelect
            allowEmpty
            disabled={!canManage}
            label="Monitor stage"
            onChange={(value) => setDraft((current) => ({ ...current, monitorStageSlug: value }))}
            options={stageOptions}
            value={draft.monitorStageSlug}
          />
        </div>
      </section>

      {canManage ? (
        <div className="flex justify-end border-t border-border pt-4">
          <button
            className="ui-button-primary"
            disabled={saveRouting.isBusy || stages.length === 0}
            onClick={() => void saveRouting.run()}
            type="button"
          >
            {saveRouting.isBusy ? "Saving…" : "Save routing"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StageSelect({
  allowEmpty,
  disabled,
  label,
  onChange,
  options,
  value,
}: {
  allowEmpty?: boolean;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  const buttonId = useId();
  const listboxId = useId();
  const selectedValueId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectOptions = useMemo(
    () => [
      ...(allowEmpty ? [{ label: "None", value: "" }] : []),
      ...options.map((option) => ({ label: option, value: option })),
    ],
    [allowEmpty, options],
  );
  const selectedOptionIndex = selectOptions.findIndex((option) => option.value === value);
  const selectedIndex = selectedOptionIndex >= 0 ? selectedOptionIndex : 0;
  const selectedOption =
    selectedOptionIndex >= 0
      ? selectOptions[selectedOptionIndex]
      : { label: value || "None", value };
  const activeOptionId = isOpen ? `${listboxId}-option-${activeIndex}` : undefined;

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  function openMenu(nextActiveIndex = selectedIndex) {
    if (disabled || selectOptions.length === 0) return;
    setActiveIndex(nextActiveIndex);
    setIsOpen(true);
  }

  function selectValue(nextValue: string) {
    onChange(nextValue);
    setIsOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || selectOptions.length === 0) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        setActiveIndex((current) => (current + 1) % selectOptions.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        setActiveIndex((current) => (current - 1 + selectOptions.length) % selectOptions.length);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        selectValue(selectOptions[activeIndex]?.value ?? selectedOption?.value ?? "");
        break;
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          setIsOpen(false);
        }
        break;
      default:
        break;
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocusedElement = event.relatedTarget;

    if (
      !(nextFocusedElement instanceof Node) ||
      !event.currentTarget.contains(nextFocusedElement)
    ) {
      setIsOpen(false);
    }
  }

  return (
    <div className="relative block space-y-1.5" onBlur={handleBlur} ref={containerRef}>
      <span className="text-[13px] font-medium text-foreground" id={buttonId}>
        {label}
      </span>
      <button
        aria-activedescendant={activeOptionId}
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-labelledby={`${buttonId} ${selectedValueId}`}
        className={cn(
          "flex min-h-10 w-full items-center justify-between gap-3 rounded-[6px] border border-border bg-surface px-3 py-2.5 text-left text-sm text-foreground outline-none transition-[border-color,box-shadow,background-color] duration-150",
          "focus-visible:border-accent/40 focus-visible:ring-4 focus-visible:ring-accent/10",
          disabled
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer hover:border-border-strong hover:bg-surface-strong",
        )}
        disabled={disabled}
        onClick={() => (isOpen ? setIsOpen(false) : openMenu(selectedIndex))}
        onKeyDown={handleKeyDown}
        role="combobox"
        type="button"
      >
        <span className="min-w-0 truncate" id={selectedValueId}>
          {selectedOption?.label ?? "None"}
        </span>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] text-muted">
          <ChevronDownIcon
            className={cn("h-4 w-4 transition-transform duration-150", isOpen ? "rotate-180" : "")}
          />
        </span>
      </button>

      {isOpen ? (
        <div
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-[8px] border border-border bg-surface py-1 [box-shadow:var(--shadow-elevated)]"
          id={listboxId}
          role="listbox"
        >
          {selectOptions.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            const optionId = `${listboxId}-option-${index}`;

            return (
              <button
                aria-selected={isSelected}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-[color,background-color] duration-100",
                  isActive ? "bg-surface-muted text-foreground" : "text-foreground",
                  isSelected ? "font-semibold" : "font-medium",
                )}
                id={optionId}
                key={option.value}
                onClick={() => selectValue(option.value)}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <span aria-hidden="true" className="w-4 shrink-0 text-muted">
                  {isSelected ? "✓" : ""}
                </span>
                <span className="min-w-0 truncate">{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
