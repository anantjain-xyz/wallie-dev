import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function GlobeIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.25 8h9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path
        d="M8 3c1.25 1.25 1.85 2.92 1.85 5S9.25 11.75 8 13M8 3C6.75 4.25 6.15 5.92 6.15 8S6.75 11.75 8 13"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
