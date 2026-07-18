import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function PlusIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path d="M8 3.5v9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
