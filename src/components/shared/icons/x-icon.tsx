import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function XIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path d="m4.5 4.5 7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m11.5 4.5-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
