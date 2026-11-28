import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function LayersIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={iconClassName(className)}
      fill="none"
      viewBox="0 0 16 16"
      {...props}
    >
      <path
        d="M2.5 5.4 8 2.5l5.5 2.9L8 8.3 2.5 5.4Zm0 2.6L8 10.9 13.5 8m-11 2.6L8 13.5l5.5-2.9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.2"
      />
    </svg>
  );
}
