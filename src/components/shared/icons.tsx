import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

type IconProps = SVGProps<SVGSVGElement>;

function iconClassName(className?: string) {
  return cn("h-4 w-4 shrink-0", className);
}

export function ChevronDownIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="m4.5 6.5 3.5 3.5 3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function BellIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M8 2.5a3 3 0 0 0-3 3V7c0 .9-.27 1.77-.77 2.52L3.5 10.6v.9h9v-.9l-.73-1.08A4.52 4.52 0 0 1 11 7V5.5a3 3 0 0 0-3-3Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M6.25 12.5a1.9 1.9 0 0 0 3.5 0"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SunIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="8" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 2.5v1M8 12.5v1M12.75 8h1M2.25 8h1M11.35 4.65l.7-.7M3.95 12.05l.7-.7M11.35 11.35l.7.7M3.95 3.95l.7.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M11.9 10.55A5.6 5.6 0 0 1 5.45 4.1 4.9 4.9 0 1 0 11.9 10.55Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LogoutIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M6 3.5H4.75A1.25 1.25 0 0 0 3.5 4.75v6.5A1.25 1.25 0 0 0 4.75 12.5H6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M8 8h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="m10.5 6 2 2-2 2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FilterIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path d="M3 4h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 8h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6.5 12h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function SlidersIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path d="M4 4h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4 12h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6" cy="4" r="1.5" fill="var(--surface)" stroke="currentColor" strokeWidth="1.2" />
      <circle
        cx="10"
        cy="12"
        r="1.5"
        fill="var(--surface)"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function LayoutIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function PlusIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path d="M8 3.5v9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="m3.5 8.25 3 3 6-6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function XIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path d="m4.5 4.5 7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m11.5 4.5-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function InboxIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M4.5 3.5h7l1.5 3v5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-5l1.5-3Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 8.5h3l1 1h1l1-1h3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ReviewsIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M6 4 3.5 6.5 6 9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 12 12.5 9.5 10 7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4 6.5h8M4 9.5h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function MyIssuesIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle
        cx="8"
        cy="8"
        r="4.75"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeDasharray="1.5 1.5"
      />
      <path
        d="M8 6v2.5l1.75 1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SparkIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M8 2.5 9.25 6.75 13.5 8 9.25 9.25 8 13.5 6.75 9.25 2.5 8 6.75 6.75 8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ProjectsIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="m8 2.75 4.5 2.5v5L8 12.75l-4.5-2.5v-5L8 2.75Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M3.75 5.5 8 8l4.25-2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ViewsIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M3 5.25 8 2.75l5 2.5-5 2.5-5-2.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M3 8.25 8 10.75l5-2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MoreIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="4" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

export function IssueBarsIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <rect x="2.5" y="8" width="2.2" height="5" rx="0.8" fill="currentColor" />
      <rect x="6.9" y="5.5" width="2.2" height="7.5" rx="0.8" fill="currentColor" />
      <rect x="11.3" y="3" width="2.2" height="10" rx="0.8" fill="currentColor" />
    </svg>
  );
}

export function StateCircleIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle
        cx="8"
        cy="8"
        r="4.25"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="1.5 1.5"
      />
    </svg>
  );
}

export function PriorityTriangleIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M8 3.25 12.75 12h-9.5L8 3.25Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UsersIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M2.75 12c.45-1.65 1.7-2.5 3.25-2.5S8.8 10.35 9.25 12"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="11.25" cy="6.5" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M10 9.9c1.25.15 2 .78 2.45 1.85"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CodeIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M6 5 3.5 8 6 11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m10 5 2.5 3-2.5 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m8.75 4.5-1.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function BranchIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="4.5" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11.5" cy="4" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="12" r="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.5 5.5v5M6 4h2.2a3.3 3.3 0 0 1 3.3 3.3V10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function LockIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <rect
        x="3.75"
        y="7"
        width="8.5"
        height="5.75"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M5.75 7V5.75a2.25 2.25 0 0 1 4.5 0V7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function GlobeIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.25 8h9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M8 3c1.25 1.25 1.85 2.92 1.85 5S9.25 11.75 8 13M8 3C6.75 4.25 6.15 5.92 6.15 8S6.75 11.75 8 13"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ArchiveIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M3.5 5.75h9v6a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-6Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M3 3.25h10v2.5H3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6.5 8h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Priority indicator icons                                          */
/* ------------------------------------------------------------------ */

const priorityColors: Record<string, { active: string; inactive: string }> = {
  urgent: { active: "#e2553a", inactive: "#e2553a" },
  high: { active: "#f2994a", inactive: "#d5d9e0" },
  medium: { active: "#f2c94c", inactive: "#d5d9e0" },
  low: { active: "#8b97a8", inactive: "#d5d9e0" },
  none: { active: "#d5d9e0", inactive: "#d5d9e0" },
};

export function PriorityUrgentIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M2.457 6.554 6.971 2.04c.58-.58 1.52-.58 2.1 0l4.514 4.514c.58.58.58 1.519 0 2.1L9.071 13.17c-.58.58-1.52.58-2.1 0L2.457 8.654c-.58-.58-.58-1.52 0-2.1Z"
        fill="#e2553a"
        fillOpacity="0.15"
        stroke="#e2553a"
        strokeWidth="1"
      />
      <path d="M8 5v3" stroke="#e2553a" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="10" r="0.75" fill="#e2553a" />
    </svg>
  );
}

export function PriorityBarIcon({
  className,
  priority,
  ...props
}: IconProps & { priority: string }) {
  if (priority === "urgent") {
    return <PriorityUrgentIcon className={className} {...props} />;
  }

  if (priority === "none") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className={iconClassName(className)}
        fill="none"
        {...props}
      >
        <path
          d="M3 4h10M3 8h10M3 12h10"
          stroke="#bec2c8"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="0.5 3.5"
        />
      </svg>
    );
  }

  const colors = priorityColors[priority] ?? priorityColors.none;
  const filledBars =
    priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0;

  // Vertical ascending bars (signal strength style), bottom-aligned
  const bars = [
    { x: 2, height: 3 }, // shortest
    { x: 5.5, height: 6 }, // medium
    { x: 9, height: 9 }, // tallest
  ];

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      {bars.map((bar, i) => (
        <rect
          key={i}
          x={bar.x}
          y={13 - bar.height}
          width="2.5"
          height={bar.height}
          rx="1"
          fill={i < filledBars ? colors.active : colors.inactive}
        />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Status circle icons                                               */
/* ------------------------------------------------------------------ */

export function StatusBacklogIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#bec2c8" strokeWidth="1.5" strokeDasharray="1.5 2" />
    </svg>
  );
}

export function StatusTodoIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#e8e9ec" strokeWidth="1.5" />
    </svg>
  );
}

export function StatusInProgressIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#f2c94c" strokeWidth="1.5" />
      <path d="M7 3.25A3.75 3.75 0 0 1 10.75 7H7V3.25Z" fill="#f2c94c" />
    </svg>
  );
}

export function StatusInReviewIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#5e6ad2" strokeWidth="1.5" />
      <path d="M7 3.25A3.75 3.75 0 0 1 10.75 7 3.75 3.75 0 0 1 7 10.75V3.25Z" fill="#5e6ad2" />
    </svg>
  );
}

export function StatusDoneIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" fill="#5e6ad2" stroke="#5e6ad2" strokeWidth="1.5" />
      <path
        d="M5 7l1.5 1.5L9 5.5"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StatusCanceledIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#95979f" strokeWidth="1.5" />
      <path
        d="M5.25 5.25l3.5 3.5M8.75 5.25l-3.5 3.5"
        stroke="#95979f"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function WorkspaceGlyph({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <rect
        x="3.25"
        y="3.25"
        width="9.5"
        height="9.5"
        rx="2.25"
        fill="currentColor"
        opacity="0.18"
      />
      <path
        d="M8 4.5v7M4.5 8h7M5.75 5.75h4.5M5.75 10.25h4.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
