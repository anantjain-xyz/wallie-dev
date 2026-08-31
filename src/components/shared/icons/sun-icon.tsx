import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function SunIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="8" cy="8" r="2.75" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 2.5v1M8 12.5v1M12.75 8h1M2.25 8h1M11.35 4.65l.7-.7M3.95 12.05l.7-.7M11.35 11.35l.7.7M3.95 3.95l.7.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
