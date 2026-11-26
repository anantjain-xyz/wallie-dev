"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import type { z } from "zod/v4";

import { MultiSelectField } from "@/components/ui/multi-select-field";
import { SelectField, type SelectOption } from "@/components/ui/select";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  configureLinearDiscoverySchema,
  configureLinearOutboundSchema,
  linearDiscoveryConfigSchema,
  linearOutboundConfigSchema,
  linearPolicyRevisionSchema,
} from "@/lib/connectors/linear-policy-contracts";

import { CatalogStatus, ResourceIdDetails, useConnectorCatalog } from "./catalog";
import { connectorCommand, readConnectorResponse } from "./request";
import type { ConnectorResource } from "./resources";
import { ConnectorSelect } from "./select";

type Discovery = z.output<typeof linearDiscoveryConfigSchema>;
type Outbound = z.output<typeof linearOutboundConfigSchema>;
type Catalog = ReturnType<typeof useConnectorCatalog>;

function queryFor(resourceId: string, kind: "state" | "label" | "team", teamId?: string) {
  const params = new URLSearchParams({ provider: "linear", kind, resourceId });
  if (teamId) params.set("teamId", teamId);
  return params.toString();
}

function choices(catalog: Catalog) {
  return catalog.catalog?.resources ?? [];
}

function pendingChoice(catalog: Catalog) {
  if (catalog.loadFailed) return "Could not verify saved choice";
  if (catalog.loading) return "Checking saved choice…";
  if (catalog.catalog?.nextCursor) return "Saved choice — load more options";
  return "Unavailable — choose a replacement";
}

function focusError(form: HTMLFormElement, id: string) {
  form.ownerDocument.getElementById(id)?.focus();
}

export function LinearConnectorPolicies({
  factoryEndpoint,
  onChanged,
  resource,
}: {
  factoryEndpoint: string;
  onChanged: () => void;
  resource: ConnectorResource;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="border-t border-border pt-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-semibold text-foreground">
        Linear routing and outcomes
      </summary>
      {open ? (
        <PolicyForms factoryEndpoint={factoryEndpoint} onChanged={onChanged} resource={resource} />
      ) : null}
    </details>
  );
}

function PolicyForms({
  factoryEndpoint,
  onChanged,
  resource,
}: {
  factoryEndpoint: string;
  onChanged: () => void;
  resource: ConnectorResource;
}) {
  const discoveryUrl = `${factoryEndpoint}/linear-discovery/${resource.id}`;
  const outboundUrl = `${factoryEndpoint}/linear-outbound/${resource.id}`;
  const [config, setConfig] = useState<{ discovery: Discovery; outbound: Outbound } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    const options = { signal: abort.signal };
    void Promise.all([
      fetch(discoveryUrl, options).then((response) =>
        readConnectorResponse(response, linearDiscoveryConfigSchema),
      ),
      fetch(outboundUrl, options).then((response) =>
        readConnectorResponse(response, linearOutboundConfigSchema),
      ),
    ])
      .then(([discovery, outbound]) => {
        if (!abort.signal.aborted) setConfig({ discovery, outbound });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoadError(true);
      });
    return () => abort.abort();
  }, [discoveryUrl, outboundUrl, reload]);

  if (loadError)
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p className="text-sm text-danger" role="alert">
          Linear policy settings are unavailable.
        </p>
        <button
          className="ui-button"
          onClick={() => {
            setLoadError(false);
            setReload((value) => value + 1);
          }}
          type="button"
        >
          Retry loading policies
        </button>
      </div>
    );
  if (!config)
    return (
      <p className="mt-3 text-sm text-muted" role="status">
        Loading Linear policies…
      </p>
    );

  const endpoint = `${factoryEndpoint}/connectors`;
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <DiscoveryForm
        endpoint={endpoint}
        initial={config.discovery}
        onChanged={onChanged}
        resourceId={resource.id}
        url={discoveryUrl}
      />
      <OutboundForm
        endpoint={endpoint}
        initial={config.outbound}
        onChanged={onChanged}
        resource={resource}
        url={outboundUrl}
      />
    </div>
  );
}

function DiscoveryForm({
  endpoint,
  initial,
  onChanged,
  resourceId,
  url,
}: {
  endpoint: string;
  initial: Discovery;
  onChanged: () => void;
  resourceId: string;
  url: string;
}) {
  const id = useId();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [stateIds, setStateIds] = useState(initial.stateIds);
  const [labelId, setLabelId] = useState(initial.labelId ?? "");
  const [saved, setSaved] = useState({
    enabled: initial.enabled,
    stateIds: initial.stateIds,
    labelId: initial.labelId,
  });
  const [errors, setErrors] = useState<{ states?: string; label?: string }>({});
  const [expectedRevision, setExpectedRevision] = useState(initial.revision);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const states = useConnectorCatalog(
    endpoint,
    queryFor(resourceId, "state"),
    initial.stateIds.join(","),
  );
  const labels = useConnectorCatalog(
    endpoint,
    queryFor(resourceId, "label"),
    initial.labelId ?? "",
  );
  const unknownStates = stateIds.filter(
    (value) => !choices(states).some((item) => item.id === value),
  );
  const save = useApiAction<
    { revision: number },
    [z.output<typeof configureLinearDiscoverySchema>]
  >({
    call: (command) => fetch(url, connectorCommand(command, "PUT")),
    errorText: "Could not save Linear intake.",
    onSuccess: (payload, [command]) => {
      setExpectedRevision(linearPolicyRevisionSchema.parse(payload).revision);
      setSaved({
        enabled: command.enabled,
        stateIds: command.stateIds,
        labelId: command.labelId ?? null,
      });
      onChanged();
    },
    setFlashMessage: setMessage,
    successText: "Linear intake saved.",
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const disabling = !enabled && saved.enabled;
    const nextErrors = disabling
      ? {}
      : {
          states:
            stateIds.length < 1 || stateIds.length > 20
              ? "Select 1–20 workflow states."
              : unknownStates.length > 0
                ? "Remove or replace choices that could not be verified."
                : undefined,
          label:
            labelId && !choices(labels).some((item) => item.id === labelId)
              ? "Choose an available issue label or remove the filter."
              : undefined,
        };
    setErrors(nextErrors);
    setMessage(null);
    if (nextErrors.states || nextErrors.label) {
      focusError(event.currentTarget, `${id}-${nextErrors.states ? "states" : "label"}`);
      return;
    }
    const command = configureLinearDiscoverySchema.safeParse({
      expectedRevision,
      mappingRevision: initial.mappingRevision,
      enabled,
      stateIds: disabling ? saved.stateIds : stateIds,
      labelId: (disabling ? saved.labelId : labelId) || undefined,
      serviceActorId: initial.serviceActorId ?? undefined,
    });
    if (!command.success) {
      setMessage({
        kind: "error",
        text: "Could not prepare the Linear intake policy. Reload the policy and try again.",
      });
      return;
    }
    void save.run(command.data);
  }

  return (
    <form className="min-w-0 space-y-3 rounded-md border border-border p-3" onSubmit={submit}>
      <h4 className="text-sm font-semibold text-foreground">Issue intake</h4>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          type="checkbox"
        />
        Discover issues on this resource
      </label>
      <MultiSelectField
        description="Choose 1–20 states. Only issues in these states can enter this factory."
        disabled={save.isBusy}
        emptyMessage="No workflow states to show for this mapping."
        error={errors.states}
        id={`${id}-states`}
        label="Workflow states"
        onValuesChange={(values) => {
          setStateIds(values);
          setErrors((current) => ({ ...current, states: undefined }));
        }}
        options={[
          ...choices(states).map((item) => ({
            value: item.id,
            label: item.label,
            description: item.description,
          })),
          ...unknownStates.map((value, index) => ({
            value,
            label: pendingChoice(states),
            description: `saved state ${index + 1}`,
          })),
        ]}
        summary={stateIds.length ? `${stateIds.length} selected` : "Choose workflow states"}
        values={stateIds}
      />
      <CatalogStatus catalog={states} label="workflow states" />
      <ResourceIdDetails ids={unknownStates} label="Unverified state ID" />
      <PolicyChoice
        catalog={labels}
        custom
        empty="No label filter"
        error={errors.label}
        id={`${id}-label`}
        label="Issue label (optional)"
        onChange={(value) => {
          setLabelId(value);
          setErrors((current) => ({ ...current, label: undefined }));
        }}
        value={labelId}
      />
      <CatalogStatus catalog={labels} label="issue labels" />
      {!enabled && saved.enabled ? (
        <p className="text-xs text-muted">
          Saving while intake is off keeps the last saved filters.
        </p>
      ) : null}
      <button
        className="ui-button-primary"
        disabled={save.isBusy || (!enabled && expectedRevision === 0)}
        type="submit"
      >
        {save.isBusy ? "Saving…" : "Save intake"}
      </button>
      <InlineActionMessage message={message} />
    </form>
  );
}

function OutboundForm({
  endpoint,
  initial,
  onChanged,
  resource,
  url,
}: {
  endpoint: string;
  initial: Outbound;
  onChanged: () => void;
  resource: ConnectorResource;
  url: string;
}) {
  const id = useId();
  const [commentsEnabled, setCommentsEnabled] = useState(initial.commentsEnabled);
  const [changeStatus, setChangeStatus] = useState(initial.statusMapping !== null);
  const [selectedTeam, setSelectedTeam] = useState(initial.statusMapping?.teamId ?? "");
  const [fromStateId, setFromStateId] = useState(initial.statusMapping?.fromStateId ?? "");
  const [toStateId, setToStateId] = useState(initial.statusMapping?.toStateId ?? "");
  const [expectedRevision, setExpectedRevision] = useState(initial.revision);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [errors, setErrors] = useState<{ team?: string; from?: string; to?: string }>({});
  const teams = useConnectorCatalog(
    endpoint,
    changeStatus && resource.kind === "project" ? queryFor(resource.id, "team") : null,
    initial.statusMapping?.teamId ?? "",
  );
  const onlyTeam =
    teams.catalog?.nextCursor === null && choices(teams).length === 1
      ? choices(teams)[0]
      : undefined;
  const teamId =
    resource.kind === "team" ? resource.externalId : selectedTeam || onlyTeam?.id || "";
  const validTeam = resource.kind === "team" || choices(teams).some((item) => item.id === teamId);
  const states = useConnectorCatalog(
    endpoint,
    changeStatus && validTeam
      ? queryFor(resource.id, "state", resource.kind === "team" ? undefined : teamId)
      : null,
    teamId === initial.statusMapping?.teamId
      ? [initial.statusMapping.fromStateId, initial.statusMapping.toStateId].join(",")
      : "",
  );
  const save = useApiAction<{ revision: number }, [z.output<typeof configureLinearOutboundSchema>]>(
    {
      call: (command) => fetch(url, connectorCommand(command, "PUT")),
      errorText: "Could not save Linear outcomes.",
      onSuccess: (payload) => {
        setExpectedRevision(linearPolicyRevisionSchema.parse(payload).revision);
        onChanged();
      },
      setFlashMessage: setMessage,
      successText: "Linear outcomes saved.",
    },
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = changeStatus
      ? {
          team: !validTeam ? "Choose an available team on this project." : undefined,
          from: !choices(states).some((item) => item.id === fromStateId)
            ? "Choose an available starting state."
            : undefined,
          to: !choices(states).some((item) => item.id === toStateId)
            ? "Choose an available destination state."
            : fromStateId === toStateId
              ? "Choose a different state from the starting state."
              : undefined,
        }
      : {};
    setErrors(nextErrors);
    setMessage(null);
    if (nextErrors.team || nextErrors.from || nextErrors.to) {
      focusError(
        event.currentTarget,
        `${id}-${nextErrors.team ? "team" : nextErrors.from ? "from" : "to"}`,
      );
      return;
    }
    const command = configureLinearOutboundSchema.safeParse({
      expectedRevision,
      mappingRevision: initial.mappingRevision,
      commentsEnabled,
      statusMapping: changeStatus
        ? {
            teamId,
            fromStateId,
            toStateId,
          }
        : null,
    });
    if (!command.success) {
      setMessage({
        kind: "error",
        text: "Could not prepare the Linear outcome policy. Reload the policy and try again.",
      });
      return;
    }
    void save.run(command.data);
  }

  return (
    <form className="min-w-0 space-y-3 rounded-md border border-border p-3" onSubmit={submit}>
      <h4 className="text-sm font-semibold text-foreground">Linked outcomes</h4>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          checked={commentsEnabled}
          onChange={(event) => setCommentsEnabled(event.target.checked)}
          type="checkbox"
        />
        Post updates to linked issues
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          checked={changeStatus}
          onChange={(event) => setChangeStatus(event.target.checked)}
          type="checkbox"
        />
        Change issue status after final approval
      </label>
      {changeStatus ? (
        <div className="space-y-3">
          {resource.kind === "project" ? (
            <>
              <PolicyChoice
                catalog={teams}
                custom
                empty="Choose a team"
                error={errors.team}
                id={`${id}-team`}
                label="Linear team"
                onChange={(value) => {
                  if (value === teamId) return;
                  setSelectedTeam(value);
                  setFromStateId("");
                  setToStateId("");
                  setErrors({});
                }}
                required
                value={teamId}
              />
              <CatalogStatus catalog={teams} label="project teams" />
              {teams.catalog && choices(teams).length === 0 && !teams.catalog.nextCursor ? (
                <p className="text-xs text-muted">No eligible teams were found for this project.</p>
              ) : null}
            </>
          ) : null}
          <PolicyChoice
            catalog={states}
            disabled={!validTeam}
            empty="Choose a state"
            error={errors.from}
            id={`${id}-from`}
            label="From state"
            onChange={(value) => {
              setFromStateId(value);
              setErrors((current) => ({ ...current, from: undefined, to: undefined }));
            }}
            required
            value={fromStateId}
          />
          <PolicyChoice
            catalog={states}
            disabled={!validTeam}
            empty="Choose a state"
            error={errors.to}
            id={`${id}-to`}
            label="To state"
            onChange={(value) => {
              setToStateId(value);
              setErrors((current) => ({ ...current, to: undefined }));
            }}
            required
            value={toStateId}
          />
          {validTeam ? <CatalogStatus catalog={states} label="outcome states" /> : null}
        </div>
      ) : null}
      <button className="ui-button-primary" disabled={save.isBusy} type="submit">
        {save.isBusy ? "Saving…" : "Save outcomes"}
      </button>
      <InlineActionMessage message={message} />
    </form>
  );
}

function PolicyChoice({
  catalog,
  custom,
  disabled,
  empty,
  error,
  id,
  label,
  onChange,
  required,
  value,
}: {
  catalog: Catalog;
  custom?: boolean;
  disabled?: boolean;
  empty: string;
  error?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  required?: boolean;
  value: string;
}) {
  const catalogOptions = choices(catalog);
  const missing = value !== "" && !catalogOptions.some((item) => item.id === value);
  const options: SelectOption[] = [
    { value: "", label: empty },
    ...(missing ? [{ value, label: pendingChoice(catalog), disabled: true }] : []),
    ...catalogOptions.map((item) => ({
      value: item.id,
      label: item.description ? `${item.label} · ${item.description}` : item.label,
    })),
  ];
  const fieldProps = {
    "aria-describedby": error ? `${id}-error` : undefined,
    "aria-invalid": error ? true : undefined,
    "aria-required": required,
    disabled,
    id,
    label,
    value,
  };
  return (
    <div className="space-y-1.5">
      {custom ? (
        <SelectField
          {...fieldProps}
          className="max-w-xs"
          onValueChange={onChange}
          options={options}
          wrap
        />
      ) : (
        <ConnectorSelect {...fieldProps} onChange={(event) => onChange(event.target.value)}>
          {options.map((item) => (
            <option disabled={item.disabled} key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </ConnectorSelect>
      )}
      {error ? (
        <p className="text-xs font-medium text-danger" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
      {missing ? (
        <ResourceIdDetails
          ids={[value]}
          label="Saved provider ID"
          summaryTabIndex={custom ? 0 : undefined}
        />
      ) : null}
    </div>
  );
}
