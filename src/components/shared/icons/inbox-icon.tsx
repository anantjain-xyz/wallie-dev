import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
