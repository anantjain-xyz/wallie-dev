import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function MoonIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M11.9 10.55A5.6 5.6 0 0 1 5.45 4.1 4.9 4.9 0 1 0 11.9 10.55Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
