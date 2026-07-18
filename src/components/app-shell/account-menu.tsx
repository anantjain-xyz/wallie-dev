"use client";

import { LogoutIcon } from "@/components/shared/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type AccountMenuProps = {
  email: string | null;
};

export function AccountMenu({ email }: AccountMenuProps) {
  const initial = (email?.trim().charAt(0) ?? "").toUpperCase() || "?";
  const triggerLabel = email ? "Account: " + email : "Account";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ui-icon-button"
          aria-label={triggerLabel}
          title={triggerLabel}
        >
          <span
            aria-hidden="true"
            className="flex h-5 w-5 items-center justify-center rounded-full bg-control-hover type-annotation font-semibold text-foreground"
          >
            {initial}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56" label="Account">
        <div className="px-3 py-2">
          <p className="type-annotation font-medium uppercase tracking-wide text-muted">
            Signed in as
          </p>
          <p className="mt-0.5 truncate text-sm text-foreground" title={email ?? undefined}>
            {email ?? "Unknown account"}
          </p>
        </div>
        <DropdownMenuSeparator />
        <form action="/auth/signout" method="post">
          <DropdownMenuItem asChild>
            <button
              type="submit"
              className="flex w-full items-center gap-2 text-left text-sm text-foreground"
            >
              <LogoutIcon className="h-3.5 w-3.5" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
