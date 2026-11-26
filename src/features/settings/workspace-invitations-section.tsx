"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { XIcon } from "@/components/shared/icons/x-icon";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select";
import { Status } from "@/components/ui/status";
import type { WorkspaceInvitationsSnapshot } from "@/features/settings/data";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import { dateFormatter } from "@/features/settings/settings-ui";
import { readResponseJson } from "@/features/settings/use-api-action";
import { ROLE_OPTIONS, roleLabel } from "@/features/settings/workspace-member-roles";
import type {
  WorkspaceInvitation,
  WorkspaceInvitationResponse,
  WorkspaceInvitationRole,
} from "@/lib/workspace-invitations/contracts";

function formatDate(value: string | null) {
  if (!value) return "Not sent";
  return dateFormatter.format(new Date(value));
}

function rowTime(timestamp: string) {
  const subMilliseconds = timestamp.match(/\.\d{3}(\d+)/)?.[1];
  return Date.parse(timestamp) + (subMilliseconds ? Number(`0.${subMilliseconds}`) : 0);
}

function isNewerMutation(snapshot: WorkspaceInvitationsSnapshot, mutation: WorkspaceInvitation) {
  const observed = snapshot.invitations.find(({ id }) => id === mutation.id);
  const updatedAt = rowTime(mutation.updatedAt);
  return observed ? updatedAt > rowTime(observed.updatedAt) : updatedAt >= snapshot.asOf;
}

export function WorkspaceInvitationsSection({
  snapshot,
  workspaceId,
}: {
  snapshot: WorkspaceInvitationsSnapshot;
  workspaceId: string;
}) {
  const { feedback, setMessage: setFlashMessage } = useIslandFeedback();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [latestSnapshot, setLatestSnapshot] = useState(snapshot);
  const [mutations, setMutations] = useState<WorkspaceInvitation[]>([]);
  const [role, setRole] = useState<WorkspaceInvitationRole>("member");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busyActionRef = useRef<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitationPendingRevocation, setInvitationPendingRevocation] =
    useState<WorkspaceInvitation | null>(null);
  const { asOf } = latestSnapshot;
  const [elapsedUntil, setElapsedUntil] = useState(asOf);
  const serverOffset = useRef(-Infinity);
  const now = Math.max(asOf, elapsedUntil);

  if (snapshot !== latestSnapshot && snapshot.asOf >= asOf) {
    setLatestSnapshot(snapshot);
    setMutations(mutations.filter((mutation) => isNewerMutation(snapshot, mutation)));
  }

  const invitations = useMemo(() => {
    const newerMutations = mutations.filter((mutation) =>
      isNewerMutation(latestSnapshot, mutation),
    );
    const overriddenIds = new Set(newerMutations.map(({ id }) => id));
    return [
      ...newerMutations.filter(({ status }) => status === "pending"),
      ...latestSnapshot.invitations.filter(({ id }) => !overriddenIds.has(id)),
    ];
  }, [latestSnapshot, mutations]);

  useEffect(() => {
    const observedAt = performance.now();
    serverOffset.current = Math.max(serverOffset.current, asOf - observedAt);
    const serverNow = serverOffset.current + observedAt;
    const nextExpiry = invitations.reduce((soonest, invitation) => {
      const expires = Date.parse(invitation.expiresAt);
      return expires > now ? Math.min(soonest, expires) : soonest;
    }, Infinity);
    if (!Number.isFinite(nextExpiry)) return;
    const timeout = window.setTimeout(
      () => setElapsedUntil(serverOffset.current + performance.now()),
      Math.min(Math.max(1, Math.ceil(nextExpiry - serverNow)), 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [asOf, invitations, now]);

  function recordMutation(invitation: WorkspaceInvitation) {
    setMutations((current) => [invitation, ...current.filter(({ id }) => id !== invitation.id)]);
  }

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
        body: JSON.stringify({ email, fullName, role }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readResponseJson<WorkspaceInvitationResponse>(response);

      recordMutation(payload.invitation);
      setEmail("");
      setFullName("");
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

  async function resendInvitation(invitationId: string) {
    if (!beginAction(`resend:${invitationId}`)) return;

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/invitations/${invitationId}/resend`,
        { method: "POST" },
      );
      const payload = await readResponseJson<WorkspaceInvitationResponse>(response);

      recordMutation(payload.invitation);
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

      recordMutation(payload.invitation);
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-foreground">Pending invitations</h3>
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
            description="Choose access and invite a teammate."
            dismissible={busyAction !== "create"}
            title="Invite a workspace member"
          >
            <form className="space-y-4" onSubmit={inviteMember}>
              <label className="block space-y-1.5">
                <span className="text-[13px] font-medium text-foreground">Name</span>
                <input
                  autoComplete="name"
                  autoFocus
                  className="ui-input"
                  disabled={busyAction === "create"}
                  maxLength={100}
                  onChange={(event) => setFullName(event.target.value)}
                  placeholder="Teammate name"
                  required
                  type="text"
                  value={fullName}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[13px] font-medium text-foreground">Email</span>
                <input
                  autoComplete="email"
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
                  disabled={busyAction !== null || !email.trim() || !fullName.trim()}
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
      {feedback}
      {invitations.length === 0 ? (
        <div className="rounded-[6px] border border-border bg-sheet px-4 py-3 text-sm text-muted">
          No pending invitations.
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-[6px] border border-border bg-sheet">
          {invitations.map((invitation) => {
            const expired = Date.parse(invitation.expiresAt) <= now;
            const resendLabel = expired ? "Send new link" : "Resend";
            const resendBusy = busyAction === `resend:${invitation.id}`;
            const revokeBusy = busyAction === `revoke:${invitation.id}`;

            return (
              <li
                className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between"
                key={invitation.id}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="[overflow-wrap:anywhere] text-sm font-medium text-foreground">
                      {invitation.fullName ?? invitation.email}
                    </p>
                    <Status
                      label={expired ? "Expired" : "Pending"}
                      value={expired ? "not_started" : "queued"}
                    />
                    <Status label={roleLabel(invitation.role)} value="not_started" />
                  </div>
                  {invitation.fullName ? (
                    <p className="[overflow-wrap:anywhere] text-xs leading-5 text-muted">
                      {invitation.email}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {invitation.lastSentAt
                      ? `Sent ${formatDate(invitation.lastSentAt)}.`
                      : "Not sent."}{" "}
                    {expired ? "Expired on" : "Expires"} {formatDate(invitation.expiresAt)}.
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    aria-label={`${resendLabel} for ${invitation.email}`}
                    className="ui-button min-h-9"
                    disabled={busyAction !== null}
                    onClick={() => void resendInvitation(invitation.id)}
                    type="button"
                  >
                    <ActionButtonLabel
                      idle={resendLabel}
                      pending={resendBusy}
                      pendingLabel="Sending…"
                    />
                  </button>
                  <DestructiveConfirmationDialog
                    actionLabel="Revoke invitation"
                    description={
                      <>
                        Revoking the invitation for <strong>{invitation.email}</strong> prevents
                        that invitation link from granting workspace access.
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
  );
}
