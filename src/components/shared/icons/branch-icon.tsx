import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
