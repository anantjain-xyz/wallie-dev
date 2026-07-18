import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function PencilIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M9.9 3.2 12.8 6M3.5 12.5l2.6-.6 6.4-6.4a1.7 1.7 0 0 0-2.4-2.4L3.7 9.5l-.6 2.6c-.1.3.1.5.4.4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
