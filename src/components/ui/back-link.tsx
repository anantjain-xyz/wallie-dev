import Link from "next/link";
import type { ComponentProps } from "react";

import { ArrowLeftIcon } from "@/components/shared/icons/arrow-left-icon";
import { cn } from "@/lib/utils";

export function BackLink({ children, className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn("inline-flex max-w-full items-center gap-1.5 text-start", className)}
      {...props}
    >
      <ArrowLeftIcon />
      <span className="min-w-0">{children}</span>
    </Link>
  );
}
