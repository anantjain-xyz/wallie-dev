"use client";

import { useState, type FormEvent } from "react";

import { PlusIcon, XIcon } from "@/components/shared/icons";
import { SelectField } from "@/components/ui/select";
import type { WorkspaceMemberSummary } from "@/features/pipeline/editor-primitives";
import type { FlashMessage } from "@/features/settings/settings-types";
import { dateFormatter, Section, StatusBadge } from "@/features/settings/settings-ui";
import { readResponseJson } from "@/features/settings/use-api-action";
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
  initialInvitations,
  setFlashMessage,
  workspaceId,
  workspaceMembers,
}: {
  canManage: boolean;
  initialInvitations: WorkspaceInvitation[];
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
}) {
  const [email, setEmail] = useState("");
  const [invitations, setInvitations] = useState(initialInvitations);
  const [role, setRole] = useState<WorkspaceInvitationRole>("member");
  const [busyAction, setBusyAction] = useState<string | null>(null);

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
            {workspaceMembers.map((member) => (
              <li
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                key={member.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {memberDisplayName(member)}
                  </p>
                  {member.email ? (
                    <p className="truncate text-[12px] leading-5 text-muted">{member.email}</p>
                  ) : null}
                </div>
                <StatusBadge tone={member.role === "owner" ? "accent" : "neutral"}>
                  {roleLabel(member.role)}
                </StatusBadge>
              </li>
            ))}
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
                        <p className="mt-1 text-[12px] leading-5 text-muted">
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
    </Section>
  );
}
