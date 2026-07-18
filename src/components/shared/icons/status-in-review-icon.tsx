import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function StatusInReviewIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#5e6ad2" strokeWidth="1.5" />
      <path d="M7 3.25A3.75 3.75 0 0 1 10.75 7 3.75 3.75 0 0 1 7 10.75V3.25Z" fill="#5e6ad2" />
    </svg>
  );
}
