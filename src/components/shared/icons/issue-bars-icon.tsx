import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function IssueBarsIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <rect x="2.5" y="8" width="2.2" height="5" rx="0.8" fill="currentColor" />
      <rect x="6.9" y="5.5" width="2.2" height="7.5" rx="0.8" fill="currentColor" />
      <rect x="11.3" y="3" width="2.2" height="10" rx="0.8" fill="currentColor" />
    </svg>
  );
}
