import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
