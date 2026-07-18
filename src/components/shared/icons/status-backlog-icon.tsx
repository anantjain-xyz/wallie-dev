import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function StatusBacklogIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#bec2c8" strokeWidth="1.5" strokeDasharray="1.5 2" />
    </svg>
  );
}
