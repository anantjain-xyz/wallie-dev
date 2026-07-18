import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

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
