"use client";

import { useEffect, useId, useState, type FormEvent } from "react";

import { PlusIcon, XIcon } from "@/components/shared/icons";
import { SelectField } from "@/components/ui/select";
import type { WorkspaceMemberSummary } from "@/features/pipeline/editor-primitives";
import type { FlashMessage } from "@/features/settings/settings-types";
import { dateFormatter, Section, StatusBadge } from "@/features/settings/settings-ui";
import { readResponseJson } from "@/features/settings/use-api-action";
import type { WorkspaceMemberResponse } from "@/lib/workspace-members/contracts";
import type {
  WorkspaceInvitation,
  WorkspaceInvitationResponse,
  WorkspaceInvitationRole,
} from "@/lib/workspace-invitations/contracts";

const ROLE_OPTIONS = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
];

function memberDisplayName(member: WorkspaceMemberSummary) {
  return member.fullName ?? member.email ?? "Unknown member";
}

function roleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatDate(value: string | null) {
  if (!value) return "Not sent";
  return dateFormatter.format(new Date(value));
}

function upsertInvitation(
  invitations: WorkspaceInvitation[],
  invitation: WorkspaceInvitation,
): WorkspaceInvitation[] {
  return [
    invitation,
    ...invitations.filter((existingInvitation) => existingInvitation.id !== invitation.id),
  ].filter((existingInvitation) => existingInvitation.status === "pending");
}

export function WorkspaceMembersSection({
  canManage,
  currentMemberId,
  initialInvitations,
  setFlashMessage,
  workspaceId,
  workspaceMembers,
}: {
  canManage: boolean;
  currentMemberId: string;
  initialInvitations: WorkspaceInvitation[];
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
}) {
  const [email, setEmail] = useState("");
  const [members, setMembers] = useState(workspaceMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [role, setRole] = useState<WorkspaceInvitationRole>("member");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [memberPendingRemoval, setMemberPendingRemoval] = useState<WorkspaceMemberSummary | null>(
    null,
  );

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction("create");

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/invitations`, {
        body: JSON.stringify({ email, role }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readResponseJson<WorkspaceInvitationResponse>(response);

      setInvitations((currentInvitations) =>
        upsertInvitation(currentInvitations, payload.invitation),
      );
      setEmail("");
      setRole("member");
      setFlashMessage({
        kind: "success",
        text: `Invitation sent to ${payload.invitation.email}.`,
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Wallie could not send that invitation.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function changeMemberRole(member: WorkspaceMemberSummary, nextRole: string) {
    if (nextRole === member.role) {
      return;
    }
    setBusyAction(`role:${member.id}`);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/members/${member.id}`, {
        body: JSON.stringify({ role: nextRole }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const payload = await readResponseJson<WorkspaceMemberResponse>(response);

      setMembers((currentMembers) =>
        currentMembers.map((existingMember) =>
          existingMember.id === payload.member.id
            ? { ...existingMember, role: payload.member.role }
            : existingMember,
        ),
      );
      setFlashMessage({
        kind: "success",
        text: `${memberDisplayName(payload.member)} is now ${roleLabel(payload.member.role)}.`,
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Wallie could not update that role.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function removeMember(member: WorkspaceMemberSummary) {
    setBusyAction(`remove:${member.id}`);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/members/${member.id}`, {
        method: "DELETE",
      });
      const payload = await readResponseJson<WorkspaceMemberResponse>(response);

      setMembers((currentMembers) =>
        currentMembers.filter((existingMember) => existingMember.id !== payload.member.id),
      );
      setMemberPendingRemoval(null);
      setFlashMessage({
        kind: "success",
        text: `${memberDisplayName(payload.member)} was removed from the workspace.`,
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Wallie could not remove that member.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function resendInvitation(invitationId: string) {
    setBusyAction(`resend:${invitationId}`);

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/invitations/${invitationId}/resend`,
        { method: "POST" },
      );
      const payload = await readResponseJson<WorkspaceInvitationResponse>(response);

      setInvitations((currentInvitations) =>
        upsertInvitation(currentInvitations, payload.invitation),
      );
      setFlashMessage({
        kind: "success",
        text: `Invitation resent to ${payload.invitation.email}.`,
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Wallie could not resend that invitation.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function revokeInvitation(invitationId: string) {
    setBusyAction(`revoke:${invitationId}`);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/invitations/${invitationId}`, {
        method: "DELETE",
      });
      const payload = await readResponseJson<WorkspaceInvitationResponse>(response);

      setInvitations((currentInvitations) =>
        currentInvitations.filter((invitation) => invitation.id !== payload.invitation.id),
      );
      setFlashMessage({
        kind: "success",
        text: `Invitation revoked for ${payload.invitation.email}.`,
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Wallie could not revoke that invitation.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <Section
      anchorId="members"
      tagline="Invite workspace collaborators and review the people who can access this workspace."
      title="Members"
    >
      <div className="space-y-6">
        {canManage ? (
          <form
            className="grid gap-3 rounded-[8px] border border-border bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_160px_auto] sm:items-end"
            onSubmit={inviteMember}
          >
            <label className="block space-y-1.5">
              <span className="text-[13px] font-medium text-foreground">Email</span>
              <input
                autoComplete="email"
                className="ui-input"
                disabled={busyAction !== null}
                inputMode="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="teammate@company.com"
                required
                spellCheck={false}
                type="email"
                value={email}
              />
            </label>
            <SelectField
              disabled={busyAction !== null}
              label="Role"
              onValueChange={(value) => setRole(value as WorkspaceInvitationRole)}
              options={ROLE_OPTIONS}
              value={role}
            />
            <button
              className="ui-button-primary min-h-10 gap-2"
              disabled={busyAction !== null}
              type="submit"
            >
              <PlusIcon />
              {busyAction === "create" ? "Sending" : "Invite"}
            </button>
          </form>
        ) : null}

        <div className="space-y-3">
          <h3 className="text-[14px] font-semibold text-foreground">Active members</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-[8px] border border-border bg-surface">
            {members.map((member) => {
              const isOwner = member.role === "owner";
              const isSelf = member.id === currentMemberId;
              // Ownership transfer is out of scope and you cannot manage your own
              // row, so those rows stay read-only even for managers.
              const canManageRow = canManage && !isOwner && !isSelf;
              const removeBusy = busyAction === `remove:${member.id}`;

              return (
                <li
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  key={member.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {memberDisplayName(member)}
                      {isSelf ? <span className="ml-2 text-xs text-muted">(you)</span> : null}
                    </p>
                    {member.email ? (
                      <p className="truncate text-xs leading-5 text-muted">{member.email}</p>
                    ) : null}
                  </div>
                  {canManageRow ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <SelectField
                        className="w-[140px]"
                        disabled={busyAction !== null}
                        label={
                          <span className="sr-only">{`Role for ${memberDisplayName(member)}`}</span>
                        }
                        onValueChange={(value) => void changeMemberRole(member, value)}
                        options={ROLE_OPTIONS}
                        value={member.role}
                      />
                      <button
                        className="ui-button min-h-9 gap-2"
                        disabled={busyAction !== null}
                        onClick={() => setMemberPendingRemoval(member)}
                        type="button"
                      >
                        <XIcon />
                        {removeBusy ? "Removing" : "Remove"}
                      </button>
                    </div>
                  ) : (
                    <StatusBadge tone={isOwner ? "accent" : "neutral"}>
                      {roleLabel(member.role)}
                    </StatusBadge>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {canManage ? (
          <div className="space-y-3">
            <h3 className="text-[14px] font-semibold text-foreground">Pending invitations</h3>
            {invitations.length === 0 ? (
              <div className="rounded-[8px] border border-border bg-surface px-4 py-3 text-sm text-muted">
                No pending invitations.
              </div>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-[8px] border border-border bg-surface">
                {invitations.map((invitation) => {
                  const resendBusy = busyAction === `resend:${invitation.id}`;
                  const revokeBusy = busyAction === `revoke:${invitation.id}`;

                  return (
                    <li
                      className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between"
                      key={invitation.id}
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">
                            {invitation.email}
                          </p>
                          <StatusBadge tone="warning">Pending</StatusBadge>
                          <StatusBadge tone="neutral">{roleLabel(invitation.role)}</StatusBadge>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted">
                          Sent {formatDate(invitation.lastSentAt)}. Expires{" "}
                          {formatDate(invitation.expiresAt)}.
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button
                          className="ui-button min-h-9"
                          disabled={busyAction !== null}
                          onClick={() => void resendInvitation(invitation.id)}
                          type="button"
                        >
                          {resendBusy ? "Resending" : "Resend"}
                        </button>
                        <button
                          className="ui-button min-h-9 gap-2"
                          disabled={busyAction !== null}
                          onClick={() => void revokeInvitation(invitation.id)}
                          type="button"
                        >
                          <XIcon />
                          {revokeBusy ? "Revoking" : "Revoke"}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {memberPendingRemoval ? (
        <RemoveMemberDialog
          busy={busyAction === `remove:${memberPendingRemoval.id}`}
          memberName={memberDisplayName(memberPendingRemoval)}
          onCancel={() => setMemberPendingRemoval(null)}
          onConfirm={() => void removeMember(memberPendingRemoval)}
        />
      ) : null}
    </Section>
  );
}

function RemoveMemberDialog({
  busy,
  memberName,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  memberName: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 isolate z-50 flex items-start justify-center overscroll-contain bg-foreground/28 px-4 py-4 backdrop-blur-sm sm:py-10">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="ui-panel-elevated relative z-10 mt-[20vh] w-full max-w-md overflow-y-auto overscroll-contain bg-surface p-5 sm:p-6"
        role="dialog"
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight text-foreground">
          Remove member
        </h2>
        <p id={descriptionId} className="mt-2 text-sm leading-6 text-muted">
          Remove <span className="font-medium text-foreground">{memberName}</span> from this
          workspace? They lose access immediately. You can re-invite them later.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button className="ui-button min-h-9" disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="ui-button-danger min-h-9"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? "Removing" : "Remove member"}
          </button>
        </div>
      </div>
    </div>
  );
}
