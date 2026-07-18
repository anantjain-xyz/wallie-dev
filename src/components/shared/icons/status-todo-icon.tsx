import { iconClassName, type IconProps } from "@/components/shared/icons/icon";

export function StatusTodoIcon({ className, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      <circle cx="7" cy="7" r="3.75" stroke="#e8e9ec" strokeWidth="1.5" />
    </svg>
  );
}
