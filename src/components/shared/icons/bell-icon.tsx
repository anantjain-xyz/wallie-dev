import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
