import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function MenuIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path d="M3 4.5h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M3 8h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
      <path d="M3 11.5h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}
