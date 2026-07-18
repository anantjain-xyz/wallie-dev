import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function PriorityUrgentIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <path
        d="M2.457 6.554 6.971 2.04c.58-.58 1.52-.58 2.1 0l4.514 4.514c.58.58.58 1.519 0 2.1L9.071 13.17c-.58.58-1.52.58-2.1 0L2.457 8.654c-.58-.58-.58-1.52 0-2.1Z"
        fill="#e2553a"
        fillOpacity="0.15"
        stroke="#e2553a"
        strokeWidth="1"
      />
      <path d="M8 5v3" stroke="#e2553a" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="10" r="0.75" fill="#e2553a" />
    </svg>
  );
}
