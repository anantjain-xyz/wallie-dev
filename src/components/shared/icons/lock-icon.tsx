import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
