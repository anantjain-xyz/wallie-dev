"use client";

import Image from "next/image";
import Link from "next/link";
import type { ComponentProps } from "react";

import { CheckIcon } from "@/components/shared/icons/check-icon";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { workspaceBasePath } from "@/lib/routes";

export type WorkspaceSwitcherOption = { name: string; slug: string };

export function WorkspaceSwitcher({
  active,
  avatarUrl,
  currentPipelineLink,
  options,
}: {
  active: WorkspaceSwitcherOption;
  avatarUrl: string | null;
  currentPipelineLink: Pick<
    ComponentProps<typeof Link>,
    "href" | "onClick" | "onFocus" | "onPointerEnter"
  >;
  options: readonly WorkspaceSwitcherOption[];
}) {
  const workspaces = [active, ...options.filter(({ slug }) => slug !== active.slug)];
  const nameCounts = new Map<string, number>();
  for (const { name } of workspaces) {
    const key = name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Switch workspace: ${active.name}`}
          className="flex min-h-10 min-w-0 max-w-48 flex-1 items-center gap-1.5 rounded-[6px] p-1 text-left hover:bg-control-hover lg:flex-initial"
          type="button"
        >
          {avatarUrl ? (
            <Image
              alt=""
              className="size-6 shrink-0 rounded-[5px] border border-border object-cover"
              height={24}
              src={avatarUrl}
              width={24}
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-[5px] border border-border bg-control-hover type-annotation font-semibold text-foreground"
            >
              {active.name.trim().charAt(0).toUpperCase() || "W"}
            </span>
          )}
          <span className="truncate text-[13px] font-medium text-foreground">{active.name}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-muted" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-52 max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto"
        label="Switch workspace"
      >
        {workspaces.map(({ name, slug }) => {
          const isCurrent = slug === active.slug;
          const ambiguousName = (nameCounts.get(name.trim().toLowerCase()) ?? 0) > 1;
          const detail = [ambiguousName && slug, isCurrent && "Current workspace"]
            .filter(Boolean)
            .join(" · ");
          return (
            <DropdownMenuItem asChild key={slug}>
              <Link
                {...(isCurrent ? currentPipelineLink : { href: workspaceBasePath(slug) })}
                aria-current={isCurrent ? "true" : undefined}
                aria-label={detail ? `${name} ${detail}` : undefined}
                className="justify-between whitespace-normal"
                prefetch={false}
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block">{name}</span>
                  {detail ? (
                    <span className="block type-annotation text-muted">{detail}</span>
                  ) : null}
                </span>
                {isCurrent ? <CheckIcon className="size-3.5 shrink-0 text-muted" /> : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
