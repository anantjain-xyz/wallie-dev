import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function FilterIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path d="M3 4h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 8h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6.5 12h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
