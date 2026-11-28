import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { EditableCombobox } from "@/components/ui/editable-combobox";
import { SelectField } from "@/components/ui/select";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { useFactoryManagementGuard } from "@/features/settings/islands/factory-management-navigation";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type { FactoryManagementMember } from "@/features/settings/workspace-factory-management";
import {
  FACTORY_NAME_MAX_LENGTH,
  FACTORY_SLUG_CHANGED,
  FACTORY_SLUG_MAX_LENGTH,
  FACTORY_SLUG_TAKEN,
  factoryNameSchema,
  factorySlugSchema,
} from "@/lib/factories/contracts";
import type { FactoryManagementCommand, FactoryRecord } from "@/lib/factories/scope";

const roleLabel = { manager: "Manager", member: "Member" } as const;
const unconfirmed = "Could not confirm the update. Reload Settings before trying again.";

function patchFactory(endpoint: string, command: FactoryManagementCommand) {
  return fetch(endpoint, {
    body: JSON.stringify(command),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
}

export function WorkspaceFactoryManagementPanel({
  factory,
  members,
  workspaceId,
}: {
  factory: FactorySelectionOption;
  members: FactoryManagementMember[];
  workspaceId: string;
}) {
  const router = useRouter();
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const archived = factory.status === "archived";
  const statusAction = archived ? "restore" : "archive";
  const statusLabel = archived ? "Restore factory" : "Archive factory";
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/factories/${encodeURIComponent(factory.id)}`;
  const mutation = useApiAction<{ factory: FactoryRecord }, [{ action: "archive" | "restore" }]>({
    call: (command) => patchFactory(endpoint, command),
    errorText: unconfirmed,
    onSuccess: ({ factory: saved }, [command]) => {
      if (
        saved?.id !== factory.id ||
        saved.is_default !== factory.isDefault ||
        saved.status !== (command.action === "archive" ? "archived" : "active")
      ) {
        throw new Error(unconfirmed);
      }
      setLifecycleOpen(false);
      startRefresh(() => router.refresh());
    },
    setFlashMessage: setMessage,
    successText: (_payload, [command]) =>
      command.action === "archive" ? "Factory archived." : "Factory restored.",
  });
  const navigating = useFactoryManagementGuard(false, mutation.isBusy || refreshing);
  const busy = mutation.isBusy || refreshing || navigating;

  return (
    <div className="space-y-6">
      {!archived ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FactoryIdentityField endpoint={endpoint} factory={factory} field="name" />
          {factory.slug ? (
            <FactoryIdentityField endpoint={endpoint} factory={factory} field="slug" />
          ) : null}
        </div>
      ) : null}
      {!lifecycleOpen && <InlineActionMessage message={message} />}
      <FactoryMembers
        archived={archived}
        endpoint={endpoint}
        factoryId={factory.id}
        members={members}
      />
      {factory.isDefault && !archived ? (
        <p className="type-secondary text-muted">The workspace default cannot be archived.</p>
      ) : (
        <DestructiveConfirmationDialog
          actionLabel={statusLabel}
          description={
            archived
              ? "Restoring makes the factory selectable again and allows new sessions when setup is ready. Existing access stays the same."
              : "Archiving removes the factory from active pickers and blocks new sessions. Existing sessions and access records are kept."
          }
          errorMessage={message?.kind === "error" ? message.text : undefined}
          onConfirm={() => void mutation.run({ action: statusAction })}
          onOpenChange={(open) => {
            if (open && busy) return;
            setLifecycleOpen(open);
            setMessage(null);
          }}
          open={lifecycleOpen}
          pending={mutation.isBusy}
          pendingLabel={archived ? "Restoring…" : "Archiving…"}
          title={`${archived ? "Restore" : "Archive"} ${factory.name}?`}
          trigger={
            <button
              className={
                archived ? "ui-button min-h-11 sm:min-h-9" : "ui-button-danger min-h-11 sm:min-h-9"
              }
              aria-disabled={busy || undefined}
              type="button"
            >
              {statusLabel}
            </button>
          }
        />
      )}
    </div>
  );
}

function FactoryIdentityField({
  endpoint,
  factory,
  field,
}: {
  endpoint: string;
  factory: FactorySelectionOption;
  field: "name" | "slug";
}) {
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const slugField = field === "slug";
  const current = factory[field] ?? "";
  const [draft, setDraft] = useState<{ expected: string; value: string } | null>(null);
  const [stale, setStale] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const value = draft?.value ?? current;
  const conflict = stale || (draft !== null && draft.expected !== current);
  const feedback =
    conflict && message?.kind !== "error"
      ? { kind: "error" as const, text: `The factory ${field} changed. Reload and try again.` }
      : message;

  const mutation = useApiAction<
    { factory: FactoryRecord },
    [Extract<FactoryManagementCommand, { action: "rename" | "set-slug" }>]
  >({
    call: async (command) => {
      const response = await patchFactory(endpoint, command);
      if (response.status !== 409) return response;
      if (command.action === "rename") {
        setStale(true);
      } else {
        const payload = (await response
          .clone()
          .json()
          .catch(() => null)) as {
          code?: unknown;
        } | null;
        if (payload?.code === FACTORY_SLUG_CHANGED) setStale(true);
        if (payload?.code === FACTORY_SLUG_TAKEN) {
          setInvalid(true);
          input.current?.focus();
        }
      }
      return response;
    },
    errorText: unconfirmed,
    onSuccess: ({ factory: saved }, [command]) => {
      if (
        saved?.id !== factory.id ||
        saved.is_default !== factory.isDefault ||
        saved.status !== "active" ||
        (command.action === "rename" ? saved.name !== command.name : saved.slug !== command.slug)
      ) {
        throw new Error(unconfirmed);
      }
      setDraft(null);
      startRefresh(() => router.refresh());
    },
    setFlashMessage: setMessage,
    successText: slugField ? "Factory slug saved." : "Factory name saved.",
  });
  const navigating = useFactoryManagementGuard(
    conflict || (draft !== null && value !== current),
    mutation.isBusy || refreshing,
  );
  const busy = mutation.isBusy || refreshing || navigating;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || conflict) return;
    const parsed = (slugField ? factorySlugSchema : factoryNameSchema).safeParse(value);
    if (!parsed.success) {
      setInvalid(true);
      setMessage({ kind: "error", text: parsed.error.issues[0].message });
      input.current?.focus();
      return;
    }
    if (parsed.data === current) {
      setDraft(null);
      setInvalid(false);
      setMessage({ kind: "info", text: "No changes to save." });
      return;
    }
    setInvalid(false);
    setMessage(null);
    void mutation.run(
      slugField
        ? { action: "set-slug", expectedSlug: draft?.expected ?? current, slug: parsed.data }
        : { action: "rename", expectedName: draft?.expected ?? current, name: parsed.data },
    );
  }

  return (
    <form className="min-w-0 space-y-1.5" noValidate onSubmit={save}>
      <label className="block type-label" htmlFor={id}>
        {slugField ? "Factory slug" : "Display name"}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-describedby={slugField ? `${id}-hint ${id}-feedback` : `${id}-feedback`}
          aria-invalid={invalid || conflict || undefined}
          autoCapitalize={slugField ? "none" : undefined}
          autoComplete="off"
          className="ui-input min-h-11 min-w-0 flex-1 sm:min-h-9"
          id={id}
          maxLength={slugField ? FACTORY_SLUG_MAX_LENGTH : FACTORY_NAME_MAX_LENGTH}
          name={field}
          onChange={(event) => {
            setDraft({ expected: draft?.expected ?? current, value: event.currentTarget.value });
            setInvalid(false);
            if (!conflict) setMessage(null);
          }}
          readOnly={busy}
          ref={input}
          required
          spellCheck={slugField ? false : undefined}
          value={value}
        />
        {!conflict ? (
          <button className="ui-button min-h-11 sm:min-h-9" disabled={busy} type="submit">
            <ActionButtonLabel
              idle={slugField ? "Save slug" : "Save name"}
              pending={mutation.isBusy}
              pendingLabel="Saving…"
            />
          </button>
        ) : null}
      </div>
      {slugField ? (
        <p className="type-annotation text-muted" id={`${id}-hint`}>
          Shown in Settings and the factory list API. Links use the factory ID; old slugs stay
          reserved.
        </p>
      ) : null}
      <div id={`${id}-feedback`}>
        <InlineActionMessage message={feedback} />
      </div>
      {conflict ? (
        <button
          className="ui-button min-h-11 sm:min-h-9"
          disabled={busy}
          onClick={() => {
            setDraft(null);
            setMessage(null);
            setStale(false);
            setInvalid(false);
            startRefresh(() => router.refresh());
          }}
          type="button"
        >
          Discard draft and reload
        </button>
      ) : null}
    </form>
  );
}

function FactoryMembers({
  archived,
  endpoint,
  factoryId,
  members,
}: {
  archived: boolean;
  endpoint: string;
  factoryId: string;
  members: FactoryManagementMember[];
}) {
  const router = useRouter();
  const id = useId();
  const memberInputId = `${id}-member`;
  const restoreFocus = useRef<HTMLElement | null>(null);
  const focusMember = useRef(false);
  const [memberId, setMemberId] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<"manager" | "member">("member");
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [removing, setRemoving] = useState<FactoryManagementMember | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const assigned = members.filter(
    (member): member is FactoryManagementMember & { factoryRole: "manager" | "member" } =>
      member.factoryRole !== null,
  );
  const selectable = members.filter(({ workspaceRole }) => workspaceRole === "member");
  const managers = assigned.filter(({ factoryRole }) => factoryRole === "manager");
  const current = selectable.find(({ id }) => id === memberId);
  const lastManager = managers.length === 1 && managers[0].id === memberId;
  const updatingAccess = current !== undefined && current.factoryRole !== role;
  const filter = search.trim().toLowerCase();
  const memberOptions = selectable
    .filter(({ label }) => label.toLowerCase().includes(filter))
    .map(({ id, label }) => ({ value: id, label }));
  const mutation = useApiAction<
    {
      membership: {
        factory_id: string;
        member_id: string;
        role: string;
        revoked_at: string | null;
      };
    },
    [string, "manager" | "member" | null]
  >({
    call: (memberId, role) =>
      fetch(`${endpoint}/members`, {
        body: JSON.stringify(role ? { memberId, role } : { memberId }),
        headers: { "Content-Type": "application/json" },
        method: role ? "POST" : "DELETE",
      }),
    errorText: "Could not confirm the access change. Reload Settings before trying again.",
    onSuccess: ({ membership }, [memberId, nextRole]) => {
      if (
        membership?.factory_id !== factoryId ||
        membership.member_id !== memberId ||
        (nextRole ? membership.role !== nextRole || membership.revoked_at : !membership.revoked_at)
      ) {
        throw new Error(
          "Could not confirm the access change. Reload Settings before trying again.",
        );
      }
      restoreFocus.current = null;
      focusMember.current = true;
      setRemoving(null);
      setMemberId("");
      setSearch("");
      setRole("member");
      startRefresh(() => router.refresh());
    },
    setFlashMessage: setMessage,
    successText: (_payload, [, role]) =>
      role ? "Factory access saved." : "Factory access removed.",
  });
  const navigating = useFactoryManagementGuard(updatingAccess, mutation.isBusy || refreshing);
  const busy = mutation.isBusy || refreshing || navigating;
  useEffect(() => {
    const input = document.getElementById(memberInputId);
    if (input instanceof HTMLInputElement) {
      input.setCustomValidity(search && !current ? "Choose a workspace member from the list." : "");
    }
  }, [archived, current, memberInputId, search]);
  useEffect(() => {
    if (busy || !focusMember.current) return;
    const input = document.getElementById(memberInputId);
    if (
      input instanceof HTMLInputElement &&
      (document.activeElement === document.body || input.form?.contains(document.activeElement))
    ) {
      input.focus({ preventScroll: true });
    }
    focusMember.current = false;
  }, [busy, memberInputId]);

  function saveAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !busy &&
      !archived &&
      current &&
      current.factoryRole !== role &&
      (!lastManager || role === "manager")
    ) {
      setMessage(null);
      void mutation.run(memberId, role);
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="type-label">Factory members</h3>
      <p className="type-secondary text-muted">Workspace owners and admins already have access.</p>
      {assigned.length ? (
        <ul className="divide-y divide-border rounded border border-border">
          {assigned.map((member) => (
            <li
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
              key={member.id}
            >
              <span className="col-span-2 min-w-0 type-body [overflow-wrap:anywhere] sm:col-span-1">
                {member.label}
              </span>
              <span className="type-label text-muted">{roleLabel[member.factoryRole]}</span>
              {!archived &&
              member.workspaceRole === "member" &&
              !(member.factoryRole === "manager" && managers.length === 1) ? (
                <button
                  aria-label={`Remove factory access for ${member.label}`}
                  className="ui-button min-h-11 sm:min-h-9"
                  disabled={busy}
                  onClick={(event) => {
                    restoreFocus.current = event.currentTarget;
                    setRemoving(member);
                    setMessage(null);
                  }}
                  type="button"
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-secondary text-muted">No assigned members.</p>
      )}
      {archived ? (
        <p className="type-secondary text-muted">Restore the factory to change access.</p>
      ) : (
        <form
          className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(7rem,1fr)_auto]"
          onSubmit={saveAccess}
        >
          <input disabled={busy} name="memberId" type="hidden" value={current?.id ?? ""} />
          <div className="col-span-2 min-w-0 space-y-1.5 sm:col-span-1">
            <label className="block type-label" htmlFor={memberInputId}>
              Workspace member
            </label>
            <EditableCombobox
              className="min-h-11 sm:min-h-9"
              disabled={busy}
              id={memberInputId}
              listboxLabel="Workspace members"
              onBlur={() => setSearch("")}
              onFocus={(event) => {
                if (focusMember.current) event.preventDefault();
              }}
              onOptionSelect={({ value }) => {
                setMemberId(value);
                setSearch("");
                setRole(selectable.find(({ id }) => id === value)?.factoryRole ?? "member");
              }}
              onValueChange={(value) => {
                setMemberId("");
                setRole("member");
                setSearch(value);
              }}
              options={memberOptions}
              placeholder="Search or select…"
              preventUnmatchedEnter
              required
              selectedValue={current?.id}
              spellCheck={false}
              status={
                memberOptions.length === 0
                  ? selectable.length === 0
                    ? "No eligible workspace members."
                    : "No matching members."
                  : undefined
              }
              value={current?.label ?? search}
            />
          </div>
          <SelectField
            disabled={busy}
            label="Factory role"
            labelClassName="type-label"
            name="role"
            onValueChange={(value) => {
              if (value === "manager" || (value === "member" && !lastManager)) setRole(value);
            }}
            options={[
              { label: "Member", value: "member", disabled: lastManager },
              { label: "Manager", value: "manager" },
            ]}
            triggerClassName="min-h-11 sm:min-h-9"
            value={role}
          />
          <button
            className="ui-button min-h-11 sm:min-h-9"
            disabled={busy || !current || current.factoryRole === role}
            type="submit"
          >
            <ActionButtonLabel
              idle="Save access"
              pending={mutation.isBusy && !removing}
              pendingLabel="Saving…"
            />
          </button>
        </form>
      )}
      {lastManager && !archived && (
        <p className="type-secondary text-muted">
          A factory must keep at least one assigned manager.
        </p>
      )}
      {!removing && <InlineActionMessage message={message} />}
      <DestructiveConfirmationDialog
        actionLabel="Remove factory access"
        description={`${removing?.label ?? ""} will lose access to this factory. Their workspace membership and access to other factories stay the same.`}
        errorMessage={message?.kind === "error" ? message.text : undefined}
        onConfirm={() => {
          if (removing) void mutation.run(removing.id, null);
        }}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            setMessage(null);
          }
        }}
        open={Boolean(removing)}
        pending={mutation.isBusy}
        pendingLabel="Removing access…"
        restoreFocusRef={restoreFocus}
        title="Remove factory access?"
      />
    </div>
  );
}
