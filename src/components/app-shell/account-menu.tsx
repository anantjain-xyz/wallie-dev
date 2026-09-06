"use client";

import { useRef } from "react";

import { LogoutIcon } from "@/components/shared/icons/logout-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { ProfileAvatar } from "@/features/settings/profile-avatar";

type AccountMenuProps = {
  avatarUrl?: string | null;
  email: string | null;
};

export function AccountMenu({ avatarUrl = null, email }: AccountMenuProps) {
  const signOutFormRef = useRef<HTMLFormElement>(null);
  const triggerLabel = email ? `Account: ${email}` : "Account";

  return (
    <DropdownMenu>
      <Tooltip content={triggerLabel}>
        <DropdownMenuTrigger asChild>
          <button type="button" className="ui-icon-button" aria-label={triggerLabel}>
            <ProfileAvatar className="h-5 w-5 type-annotation" name={email ?? ""} url={avatarUrl} />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-56" label="Account">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block type-annotation font-medium uppercase tracking-wide text-muted">
            Signed in as
          </span>
          <span className="mt-0.5 block max-w-52 truncate text-sm font-normal text-foreground">
            {email ?? "Unknown account"}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <form action="/auth/signout" method="post" ref={signOutFormRef}>
          <DropdownMenuItem
            asChild
            onSelect={(event) => {
              event.preventDefault();
              signOutFormRef.current?.requestSubmit();
            }}
          >
            <button className="w-full" type="button">
              <LogoutIcon className="h-3.5 w-3.5" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
