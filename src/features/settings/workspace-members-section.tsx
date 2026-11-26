"use client";

import { useRef, useState } from "react";

import { XIcon } from "@/components/shared/icons/x-icon";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select";
import { Status } from "@/components/ui/status";
import type { WorkspaceMemberSummary } from "@/features/pipeline/editor-primitives";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import { ProfileAvatar } from "@/features/settings/profile-avatar";
import { readResponseJson } from "@/features/settings/use-api-action";
import { ROLE_OPTIONS, roleLabel } from "@/features/settings/workspace-member-roles";
import type { WorkspaceInvitationRole } from "@/lib/workspace-invitations/contracts";
import type { WorkspaceMemberResponse } from "@/lib/workspace-members/contracts";

function memberDisplayName(member: Pick<WorkspaceMemberSummary, "email" | "fullName">) {
  return member.fullName ?? member.email ?? "Unknown member";
}

function memberActionIdentity(member: WorkspaceMemberSummary) {
  const name = memberDisplayName(member);
  return member.email && member.email !== name ? `${name} (${member.email})` : name;
}

export function WorkspaceMembersSection({
  canManage,
  currentMemberId,
  workspaceId,
  workspaceMembers,
}: {
  canManage: boolean;
  currentMemberId: string;
  workspaceId: string;
  workspaceMembers: WorkspaceMemberSummary[];
}) {
  const { feedback, setMessage: setFlashMessage } = useIslandFeedback();
  const [snapshot, setSnapshot] = useState(workspaceMembers);
  const [members, setMembers] = useState(workspaceMembers);
  if (workspaceMembers !== snapshot) {
    setSnapshot(workspaceMembers);
    setMembers(workspaceMembers);
  }
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyActionRef = useRef<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [memberRoleTarget, setMemberRoleTarget] = useState<WorkspaceMemberSummary | null>(null);
  const [memberRoleTrigger, setMemberRoleTrigger] = useState<HTMLButtonElement | null>(null);
  const [memberRoleDraft, setMemberRoleDraft] = useState<WorkspaceInvitationRole>("member");
  const [memberPendingRemoval, setMemberPendingRemoval] = useState<WorkspaceMemberSummary | null>(
    null,
  );

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

  return (
    <>
      {feedback}
      {members.length === 0 ? (
        <p className="ui-sheet px-4 py-3 type-body text-muted">No active members.</p>
      ) : (
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
                <div className="flex min-w-0 items-center gap-3">
                  <ProfileAvatar
                    className="h-10 w-10 text-sm"
                    name={memberDisplayName(member)}
                    url={member.avatarUrl}
                  />
                  <div className="min-w-0">
                    <p className="[overflow-wrap:anywhere] text-sm font-medium text-foreground">
                      {memberDisplayName(member)}
                      {isSelf ? <span className="ml-2 text-xs text-muted">(you)</span> : null}
                    </p>
                    {member.email && member.email !== memberDisplayName(member) ? (
                      <p className="[overflow-wrap:anywhere] text-xs leading-5 text-muted">
                        {member.email}
                      </p>
                    ) : null}
                  </div>
                </div>
                {canManageRow ? (
                  <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                    <button
                      aria-label={`Change role (${roleLabel(member.role)}) for ${memberActionIdentity(member)}`}
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
                          {member.email && member.email !== memberDisplayName(member) ? (
                            <span className="mb-2 block font-semibold text-foreground [overflow-wrap:anywhere]">
                              {member.email}
                            </span>
                          ) : null}
                          {
                            " Removing this member revokes their workspace access immediately. You can re-invite them later."
                          }
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
                          aria-label={`Remove ${memberActionIdentity(member)}`}
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
      )}
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
            memberRoleTarget ? (
              <>
                {memberRoleTarget.email &&
                memberRoleTarget.email !== memberDisplayName(memberRoleTarget) ? (
                  <span className="mb-2 block font-semibold text-foreground [overflow-wrap:anywhere]">
                    {memberRoleTarget.email}
                  </span>
                ) : null}
                {` Choose ${memberDisplayName(memberRoleTarget)}'s access. Changing an admin to member removes workspace management access.`}
              </>
            ) : (
              "Choose this member's workspace access."
            )
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
    </>
  );
}
