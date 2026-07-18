import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function ProjectsIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="m8 2.75 4.5 2.5v5L8 12.75l-4.5-2.5v-5L8 2.75Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M3.75 5.5 8 8l4.25-2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
