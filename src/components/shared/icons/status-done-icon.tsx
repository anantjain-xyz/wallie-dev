import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
