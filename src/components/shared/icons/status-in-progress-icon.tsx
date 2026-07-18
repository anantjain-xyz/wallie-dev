import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function StatusInProgressIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#f2c94c" strokeWidth="1.5" />
      <path d="M7 3.25A3.75 3.75 0 0 1 10.75 7H7V3.25Z" fill="#f2c94c" />
    </svg>
  );
}
