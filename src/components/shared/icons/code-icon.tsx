import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function CodeIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M6 5 3.5 8 6 11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m10 5 2.5 3-2.5 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m8.75 4.5-1.5 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
