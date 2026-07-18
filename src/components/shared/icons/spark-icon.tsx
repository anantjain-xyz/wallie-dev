import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function SparkIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M8 2.5 9.25 6.75 13.5 8 9.25 9.25 8 13.5 6.75 9.25 2.5 8 6.75 6.75 8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
