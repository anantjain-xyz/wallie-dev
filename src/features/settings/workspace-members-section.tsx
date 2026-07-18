"use client";

import { useRef, useState, type FormEvent } from "react";

import { PlusIcon, XIcon } from "@/components/shared/icons";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Status } from "@/components/ui/status";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select";
import type { WorkspaceMemberSummary } from "@/features/pipeline/editor-primitives";
import type { FlashMessage } from "@/features/settings/settings-types";
import { dateFormatter, Section } from "@/features/settings/settings-ui";
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
  const busyActionRef = useRef<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [memberRoleTarget, setMemberRoleTarget] = useState<WorkspaceMemberSummary | null>(null);
  const [memberRoleTrigger, setMemberRoleTrigger] = useState<HTMLButtonElement | null>(null);
  const [memberRoleDraft, setMemberRoleDraft] = useState<WorkspaceInvitationRole>("member");
  const [memberPendingRemoval, setMemberPendingRemoval] = useState<WorkspaceMemberSummary | null>(
    null,
  );
  const [invitationPendingRevocation, setInvitationPendingRevocation] =
    useState<WorkspaceInvitation | null>(null);

  function beginAction(action: string) {
    if (busyActionRef.current) return false;
    busyActionRef.current = action;
    setBusyAction(action);
    return true;
  }

  function finishAction() {
    busyActionRef.current = null;
    setBusyAction(null);
  }

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!beginAction("create")) return;
    setInviteError(null);

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
      setInviteOpen(false);
      setFlashMessage({
        kind: "success",
        text: `Invitation sent to ${payload.invitation.email}.`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Wallie could not send that invitation.";
      setInviteError(message);
    } finally {
      finishAction();
    }
  }

  async function changeMemberRole(member: WorkspaceMemberSummary, nextRole: string) {
    if (nextRole === member.role || !beginAction(`role:${member.id}`)) {
      return;
    }
    setDialogError(null);

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
      setMemberRoleTarget(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallie could not update that role.";
      setDialogError(message);
    } finally {
      finishAction();
    }
  }

  async function removeMember(member: WorkspaceMemberSummary) {
    if (!beginAction(`remove:${member.id}`)) return;
    setDialogError(null);

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
      const message =
        error instanceof Error ? error.message : "Wallie could not remove that member.";
      setDialogError(message);
    } finally {
      finishAction();
    }
  }

  async function resendInvitation(invitationId: string) {
    if (!beginAction(`resend:${invitationId}`)) return;

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
      finishAction();
    }
  }

  async function revokeInvitation(invitationId: string) {
    if (!beginAction(`revoke:${invitationId}`)) return;
    setDialogError(null);

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
      setInvitationPendingRevocation(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Wallie could not revoke that invitation.";
      setDialogError(message);
    } finally {
      finishAction();
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
          <div className="flex justify-end">
            <Dialog
              open={inviteOpen}
              onOpenChange={(open) => {
                if (busyAction === "create") return;
                setInviteOpen(open);
                setInviteError(null);
              }}
            >
              <DialogTrigger asChild>
                <button className="ui-button-primary min-h-10 gap-2" type="button">
                  <PlusIcon />
                  Invite member
                </button>
              </DialogTrigger>
              <DialogContent
                description="Send an invitation and choose the workspace access this person should receive."
                dismissible={busyAction !== "create"}
                title="Invite a workspace member"
              >
                <form className="space-y-4" onSubmit={inviteMember}>
                  <label className="block space-y-1.5">
                    <span className="text-[13px] font-medium text-foreground">Email</span>
                    <input
                      autoComplete="email"
                      autoFocus
                      className="ui-input"
                      disabled={busyAction === "create"}
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
                    disabled={busyAction === "create"}
                    label="Role"
                    onValueChange={(value) => setRole(value as WorkspaceInvitationRole)}
                    options={ROLE_OPTIONS}
                    value={role}
                  />
                  {inviteError ? (
                    <div className="ui-inline-message ui-inline-message-danger" role="alert">
                      {inviteError}
                    </div>
                  ) : null}
                  <DialogFooter>
                    <button
                      className="ui-button"
                      disabled={busyAction === "create"}
                      onClick={() => setInviteOpen(false)}
                      type="button"
                    >
                      Cancel
                    </button>
                    <button
                      className="ui-button-primary"
                      disabled={busyAction === "create" || !email.trim()}
                      type="submit"
                    >
                      <ActionButtonLabel
                        idle="Send invitation"
                        pending={busyAction === "create"}
                        pendingLabel="Sending…"
                      />
                    </button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}

        <div className="space-y-3">
          <h3 className="text-[14px] font-semibold text-foreground">Active members</h3>
          <ul className="divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-sheet">
            {members.map((member) => {
              const isOwner = member.role === "owner";
              const isSelf = member.id === currentMemberId;
              // Ownership transfer is out of scope and you cannot manage your own
              // row, so those rows stay read-only even for managers.
              const canManageRow = canManage && !isOwner && !isSelf;
              const removeBusy = busyAction === `remove:${member.id}`;
              const roleBusy = busyAction === `role:${member.id}`;

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
                      <button
                        className="ui-button min-h-9"
                        disabled={busyAction !== null}
                        onClick={(event) => {
                          setDialogError(null);
                          setMemberRoleDraft(member.role as WorkspaceInvitationRole);
                          setMemberRoleTrigger(event.currentTarget);
                          setMemberRoleTarget(member);
                        }}
                        type="button"
                      >
                        <ActionButtonLabel
                          idle={`Change role (${roleLabel(member.role)})`}
                          pending={roleBusy}
                          pendingLabel="Saving…"
                        />
                      </button>
                      <DestructiveConfirmationDialog
                        actionLabel="Remove member"
                        description={
                          <>
                            Removing <strong>{memberDisplayName(member)}</strong> revokes their
                            workspace access immediately. You can re-invite them later.
                          </>
                        }
                        errorMessage={memberPendingRemoval?.id === member.id ? dialogError : null}
                        onConfirm={() => void removeMember(member)}
                        onOpenChange={(open) => {
                          setDialogError(null);
                          setMemberPendingRemoval(open ? member : null);
                        }}
                        open={memberPendingRemoval?.id === member.id}
                        pending={removeBusy}
                        pendingLabel="Removing…"
                        title={`Remove ${memberDisplayName(member)}?`}
                        trigger={
                          <button
                            aria-label={`Remove ${memberDisplayName(member)}`}
                            className="ui-button min-h-9 gap-2"
                            disabled={busyAction !== null}
                            type="button"
                          >
                            <XIcon />
                            Remove
                          </button>
                        }
                      />
                    </div>
                  ) : (
                    <Status label={roleLabel(member.role)} value="not_started" />
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
              <div className="rounded-[6px] border border-border bg-sheet px-4 py-3 text-sm text-muted">
                No pending invitations.
              </div>
            ) : (
              <ul className="divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-sheet">
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
                          <Status label="Pending" value="queued" />
                          <Status label={roleLabel(invitation.role)} value="not_started" />
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
                          <ActionButtonLabel
                            idle="Resend"
                            pending={resendBusy}
                            pendingLabel="Resending…"
                          />
                        </button>
                        <DestructiveConfirmationDialog
                          actionLabel="Revoke invitation"
                          description={
                            <>
                              Revoking the invitation for <strong>{invitation.email}</strong>
                              prevents that invitation link from granting workspace access.
                            </>
                          }
                          errorMessage={
                            invitationPendingRevocation?.id === invitation.id ? dialogError : null
                          }
                          onConfirm={() => void revokeInvitation(invitation.id)}
                          onOpenChange={(open) => {
                            setDialogError(null);
                            setInvitationPendingRevocation(open ? invitation : null);
                          }}
                          open={invitationPendingRevocation?.id === invitation.id}
                          pending={revokeBusy}
                          pendingLabel="Revoking…"
                          title={`Revoke ${invitation.email}'s invitation?`}
                          trigger={
                            <button
                              aria-label={`Revoke invitation for ${invitation.email}`}
                              className="ui-button min-h-9 gap-2"
                              disabled={busyAction !== null}
                              type="button"
                            >
                              <XIcon />
                              Revoke
                            </button>
                          }
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      <Dialog
        open={memberRoleTarget !== null}
        onOpenChange={(open) => {
          if (busyAction?.startsWith("role:")) return;
          if (!open) setMemberRoleTarget(null);
          setDialogError(null);
        }}
      >
        <DialogContent
          description={
            memberRoleTarget
              ? `Choose ${memberDisplayName(memberRoleTarget)}'s access. Changing an admin to member removes workspace management access.`
              : "Choose this member's workspace access."
          }
          dismissible={!busyAction?.startsWith("role:")}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            memberRoleTrigger?.focus();
          }}
          title={
            memberRoleTarget
              ? `Change role for ${memberDisplayName(memberRoleTarget)}`
              : "Change member role"
          }
        >
          <SelectField
            disabled={busyAction?.startsWith("role:")}
            label="Role"
            onValueChange={(value) => setMemberRoleDraft(value as WorkspaceInvitationRole)}
            options={ROLE_OPTIONS}
            value={memberRoleDraft}
          />
          {dialogError ? (
            <div className="ui-inline-message ui-inline-message-danger mt-4" role="alert">
              {dialogError}
            </div>
          ) : null}
          <DialogFooter>
            <button
              className="ui-button"
              disabled={busyAction?.startsWith("role:")}
              onClick={() => setMemberRoleTarget(null)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="ui-button-primary"
              disabled={
                busyAction?.startsWith("role:") || memberRoleDraft === memberRoleTarget?.role
              }
              onClick={() => {
                if (memberRoleTarget) void changeMemberRole(memberRoleTarget, memberRoleDraft);
              }}
              type="button"
            >
              <ActionButtonLabel
                idle="Save role"
                pending={Boolean(busyAction?.startsWith("role:"))}
                pendingLabel="Saving…"
              />
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
