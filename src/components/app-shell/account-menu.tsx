import { LogoutIcon } from "@/components/shared/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";

type AccountMenuProps = {
  email: string | null;
};

export function AccountMenu({ email }: AccountMenuProps) {
  const initial = (email?.trim().charAt(0) ?? "").toUpperCase() || "?";
  const triggerLabel = email ? `Account: ${email}` : "Account";

  return (
    <DropdownMenu>
      <Tooltip content={triggerLabel}>
        <DropdownMenuTrigger asChild>
          <button type="button" className="ui-icon-button" aria-label={triggerLabel}>
            <span
              aria-hidden="true"
              className="flex h-5 w-5 items-center justify-center rounded-full bg-control-hover type-annotation font-semibold text-foreground"
            >
              {initial}
            </span>
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
        <form action="/auth/signout" method="post">
          <DropdownMenuItem asChild>
            <button className="w-full" type="submit">
              <LogoutIcon className="h-3.5 w-3.5" />
              Sign out
            </button>
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
