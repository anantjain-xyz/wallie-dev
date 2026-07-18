import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function LayoutIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
