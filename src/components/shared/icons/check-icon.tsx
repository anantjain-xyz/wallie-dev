import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function CheckIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="m3.5 8.25 3 3 6-6.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
