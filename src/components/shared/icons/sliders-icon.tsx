import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
      <circle
        cx="6"
        cy="4"
        r="1.5"
        fill="var(--surface-sheet)"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle
        cx="10"
        cy="12"
        r="1.5"
        fill="var(--surface-sheet)"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}
