import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function WorkspaceGlyph({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <rect
        x="3.25"
        y="3.25"
        width="9.5"
        height="9.5"
        rx="2.25"
        fill="currentColor"
        opacity="0.18"
      />
      <path
        d="M8 4.5v7M4.5 8h7M5.75 5.75h4.5M5.75 10.25h4.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
