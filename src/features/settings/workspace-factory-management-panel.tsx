import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type { FactoryManagementMember } from "@/features/settings/workspace-factory-management";
import { FACTORY_NAME_MAX_LENGTH } from "@/lib/factories/contracts";
import type { FactoryManagementCommand, FactoryRecord } from "@/lib/factories/scope";

const roleLabel = { manager: "Manager", member: "Member" } as const;

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
  const factoryNameId = useId();
  const [draft, setDraft] = useState<{ expectedName: string; name: string } | null>(null);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const name = draft?.name ?? factory.name;
  const changed = draft && name.trim() && name.trim() !== draft.expectedName;
  const archived = factory.status === "archived";
  const statusAction = archived ? "restore" : "archive";
  const statusLabel = archived ? "Restore factory" : "Archive factory";
  const endpoint = `/api/workspaces/${encodeURIComponent(workspaceId)}/factories/${encodeURIComponent(factory.id)}`;
  const mutation = useApiAction<{ factory: FactoryRecord }, [FactoryManagementCommand]>({
    call: (command) =>
      fetch(endpoint, {
        body: JSON.stringify(command),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      }),
    errorText: "Could not confirm the update. Reload Settings before trying again.",
    onSuccess: ({ factory: saved }, [command]) => {
      if (
        saved?.id !== factory.id ||
        saved.slug !== factory.slug ||
        saved.status !== (command.action === "archive" ? "archived" : "active") ||
        (command.action === "rename" && saved.name !== command.name.trim())
      ) {
        throw new Error("Could not confirm the update. Reload Settings before trying again.");
      }
      setLifecycleOpen(false);
      setDraft(null);
      startRefresh(() => router.refresh());
    },
    setFlashMessage: setMessage,
    successText: (_payload, [command]) =>
      command.action === "rename"
        ? "Factory name saved."
        : command.action === "archive"
          ? "Factory archived."
          : "Factory restored.",
  });
  const busy = mutation.isBusy || refreshing;

  return (
    <div className="space-y-6">
      {!archived ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && changed) {
              setMessage(null);
              void mutation.run({ action: "rename", expectedName: draft.expectedName, name });
            }
          }}
        >
          <label className="block type-label" htmlFor={factoryNameId}>
            Factory name
          </label>
          <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
            <input
              className="ui-input min-h-11 min-w-0 max-w-md sm:min-h-9 sm:flex-1"
              readOnly={busy}
              id={factoryNameId}
              maxLength={FACTORY_NAME_MAX_LENGTH}
              name="name"
              onChange={(event) =>
                setDraft({
                  expectedName: draft?.expectedName ?? factory.name,
                  name: event.currentTarget.value,
                })
              }
              required
              value={name}
            />
            <button
              className="ui-button min-h-11 justify-self-start sm:min-h-9"
              disabled={busy || !changed}
              type="submit"
            >
              <ActionButtonLabel
                idle="Save name"
                pending={!lifecycleOpen && mutation.isBusy}
                pendingLabel="Saving…"
              />
            </button>
          </div>
        </form>
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
  const restoreFocus = useRef<HTMLElement | null>(null);
  const memberSelect = useRef<HTMLSelectElement | null>(null);
  const [memberId, setMemberId] = useState("");
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
      restoreFocus.current = memberSelect.current;
      setRemoving(null);
      setMemberId("");
      setRole("member");
      startRefresh(() => router.refresh());
    },
    setFlashMessage: setMessage,
    successText: (_payload, [, role]) =>
      role ? "Factory access saved." : "Factory access removed.",
  });
  const busy = mutation.isBusy || refreshing;

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
      <h4 className="type-label">Factory members</h4>
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
              selectable.includes(member) &&
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
          <div className="col-span-2 min-w-0 space-y-1.5 sm:col-span-1">
            <label className="block type-label" htmlFor={`${id}-member`}>
              Workspace member
            </label>
            <select
              className="ui-input min-h-11 sm:min-h-9"
              id={`${id}-member`}
              disabled={mutation.isBusy}
              name="memberId"
              onChange={(event) => {
                const value = event.currentTarget.value;
                setMemberId(value);
                setRole(selectable.find(({ id }) => id === value)?.factoryRole ?? "member");
              }}
              required
              ref={memberSelect}
              value={memberId}
            >
              <option value="">Select a member</option>
              {selectable.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.label}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 space-y-1.5">
            <label className="block type-label" htmlFor={`${id}-role`}>
              Factory role
            </label>
            <select
              className="ui-input min-h-11 sm:min-h-9"
              disabled={busy}
              id={`${id}-role`}
              name="role"
              onChange={(event) =>
                setRole(event.currentTarget.value === "manager" ? "manager" : "member")
              }
              value={role}
            >
              <option disabled={lastManager} value="member">
                Member
              </option>
              <option value="manager">Manager</option>
            </select>
          </div>
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
