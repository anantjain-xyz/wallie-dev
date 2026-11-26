"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import type { SettingsWorkspaceProfile } from "@/features/settings/data";
import { useIslandFeedback } from "@/features/settings/islands/island-feedback";
import { ProfileAvatar } from "@/features/settings/profile-avatar";
import { readResponseJson } from "@/features/settings/use-api-action";
import { validateProfileAvatarFile } from "@/lib/storage/profile-avatar-contracts";
import type { ProfileAvatarAction } from "@/lib/workspace-members/contracts";

type ProfileUpdateResponse = {
  profile: { avatarUrl: string | null; fullName: string };
};

export function WorkspaceProfileSection({
  initialProfile,
}: {
  initialProfile: SettingsWorkspaceProfile;
}) {
  const { feedback, setMessage: setFlashMessage } = useIslandFeedback();
  const router = useRouter();
  const [profile, setProfile] = useState(initialProfile);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [profileDraft, setProfileDraft] = useState("");
  const [profileAvatarAction, setProfileAvatarAction] = useState<ProfileAvatarAction>("keep");
  const [profileAvatarFile, setProfileAvatarFile] = useState<File | null>(null);
  const [profileAvatarPreviewUrl, setProfileAvatarPreviewUrl] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const profileFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (profileAvatarPreviewUrl) URL.revokeObjectURL(profileAvatarPreviewUrl);
    };
  }, [profileAvatarPreviewUrl]);

  function clearProfilePhotoDraft() {
    setProfileAvatarAction("keep");
    setProfileAvatarFile(null);
    setProfileAvatarPreviewUrl(null);
    if (profileFileInputRef.current) profileFileInputRef.current.value = "";
  }

  function handleProfilePhotoChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      validateProfileAvatarFile(file);
      setProfileAvatarFile(file);
      setProfileAvatarAction("replace");
      setProfileAvatarPreviewUrl(URL.createObjectURL(file));
      setProfileError(null);
    } catch (error) {
      clearProfilePhotoDraft();
      setProfileError(error instanceof Error ? error.message : "Profile photo upload is invalid.");
    }
  }

  function removeProfilePhoto() {
    setProfileAvatarAction("remove");
    setProfileAvatarFile(null);
    setProfileAvatarPreviewUrl(null);
    setProfileError(null);
    if (profileFileInputRef.current) profileFileInputRef.current.value = "";
  }

  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProfileError(null);

    try {
      const formData = new FormData();
      formData.append("avatarAction", profileAvatarAction);
      formData.append("fullName", profileDraft);
      if (profileAvatarAction === "replace" && profileAvatarFile) {
        formData.append("file", profileAvatarFile);
      }

      const response = await fetch("/api/profile", {
        body: formData,
        method: "PATCH",
      });
      const payload = await readResponseJson<ProfileUpdateResponse>(response);

      setProfile(payload.profile);
      clearProfilePhotoDraft();
      setProfileOpen(false);
      setFlashMessage({
        kind: "success",
        text: "Your profile was updated across all workspaces.",
      });
      router.refresh();
    } catch (error) {
      setProfileError(
        error instanceof Error ? error.message : "Wallie could not update your profile.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={profileOpen}
      onOpenChange={(open) => {
        if (busy) return;
        if (open) setProfileDraft(profile.fullName ?? "");
        setProfileError(null);
        clearProfilePhotoDraft();
        setProfileOpen(open);
      }}
    >
      {feedback}
      <div className="ui-sheet flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProfileAvatar
            className="h-10 w-10 text-sm"
            name={profile.fullName ?? ""}
            url={profile.avatarUrl}
          />
          <div className="min-w-0">
            {profile.fullName ? (
              <p className="type-body font-medium text-foreground [overflow-wrap:anywhere]">
                {profile.fullName}
              </p>
            ) : null}
            <p className="type-secondary text-muted">Changes apply across all your workspaces.</p>
          </div>
        </div>
        <DialogTrigger asChild>
          <button className="ui-button min-h-9" type="button">
            Edit profile
          </button>
        </DialogTrigger>
      </div>
      <DialogContent
        description="Your name and photo are shown on member lists in every workspace you belong to."
        dismissible={!busy}
        title="Edit profile"
      >
        <form className="space-y-4" onSubmit={updateProfile}>
          <div className="flex items-center gap-4">
            <ProfileAvatar
              className="h-16 w-16 text-xl"
              name={profileDraft}
              url={
                profileAvatarAction === "remove"
                  ? null
                  : (profileAvatarPreviewUrl ?? profile.avatarUrl)
              }
            />
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <button
                className="ui-button"
                disabled={busy}
                onClick={() => profileFileInputRef.current?.click()}
                type="button"
              >
                {profileAvatarAction !== "remove" && (profileAvatarPreviewUrl || profile.avatarUrl)
                  ? "Change photo"
                  : "Add photo"}
              </button>
              {profileAvatarAction !== "remove" &&
              (profileAvatarPreviewUrl || profile.avatarUrl) ? (
                <button
                  className="ui-button"
                  disabled={busy}
                  onClick={removeProfilePhoto}
                  type="button"
                >
                  Remove photo
                </button>
              ) : null}
              <input
                ref={profileFileInputRef}
                accept=".jpg,.jpeg,.png,.webp"
                aria-hidden="true"
                className="sr-only"
                disabled={busy}
                onChange={handleProfilePhotoChange}
                tabIndex={-1}
                type="file"
              />
              <p className="w-full text-xs leading-5 text-muted">PNG, JPEG, or WebP. Up to 2 MB.</p>
            </div>
          </div>
          <label className="block space-y-1.5">
            <span className="text-[13px] font-medium text-foreground">Name</span>
            <input
              autoComplete="name"
              autoFocus
              className="ui-input"
              disabled={busy}
              maxLength={100}
              onChange={(event) => setProfileDraft(event.target.value)}
              required
              type="text"
              value={profileDraft}
            />
          </label>
          {profileError ? (
            <div className="ui-inline-message ui-inline-message-danger" role="alert">
              {profileError}
            </div>
          ) : null}
          <DialogFooter>
            <button
              className="ui-button"
              disabled={busy}
              onClick={() => {
                clearProfilePhotoDraft();
                setProfileOpen(false);
              }}
              type="button"
            >
              Cancel
            </button>
            <button
              className="ui-button-primary"
              disabled={busy || !profileDraft.trim()}
              type="submit"
            >
              <ActionButtonLabel idle="Save profile" pending={busy} pendingLabel="Saving…" />
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
