import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export const ARROW_LEFT_PATH = "M12.5 8h-9M7 4.5 3.5 8 7 11.5";

export function ArrowLeftIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d={ARROW_LEFT_PATH}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
