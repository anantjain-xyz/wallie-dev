import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

export type IconProps = SVGProps<SVGSVGElement>;

export function iconClassName(className?: string) {
  return cn("h-4 w-4 shrink-0", className);
}
