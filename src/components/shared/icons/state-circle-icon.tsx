import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function StateCircleIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle
        cx="8"
        cy="8"
        r="4.25"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="1.5 1.5"
      />
    </svg>
  );
}
