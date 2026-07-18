import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
