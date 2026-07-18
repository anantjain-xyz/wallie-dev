import { iconClassName, type IconProps } from "@/components/shared/icons/icon";
import { PriorityUrgentIcon } from "@/components/shared/icons/priority-urgent-icon";

const priorityColors: Record<string, { active: string; inactive: string }> = {
  urgent: { active: "#e2553a", inactive: "#e2553a" },
  high: { active: "#f2994a", inactive: "#d5d9e0" },
  medium: { active: "#f2c94c", inactive: "#d5d9e0" },
  low: { active: "#8b97a8", inactive: "#d5d9e0" },
  none: { active: "#d5d9e0", inactive: "#d5d9e0" },
};

export function PriorityBarIcon({
  className,
  priority,
  ...props
}: IconProps & { priority: string }) {
  if (priority === "urgent") {
    return <PriorityUrgentIcon className={className} {...props} />;
  }

  if (priority === "none") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className={iconClassName(className)}
        fill="none"
        {...props}
      >
        <path
          d="M3 4h10M3 8h10M3 12h10"
          stroke="#bec2c8"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray="0.5 3.5"
        />
      </svg>
    );
  }

  const colors = priorityColors[priority] ?? priorityColors.none;
  const filledBars =
    priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0;

  // Vertical ascending bars (signal strength style), bottom-aligned
  const bars = [
    { x: 2, height: 3 }, // shortest
    { x: 5.5, height: 6 }, // medium
    { x: 9, height: 9 }, // tallest
  ];

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={iconClassName(className)}
      fill="none"
      {...props}
    >
      {bars.map((bar, i) => (
        <rect
          key={i}
          x={bar.x}
          y={13 - bar.height}
          width="2.5"
          height={bar.height}
          rx="1"
          fill={i < filledBars ? colors.active : colors.inactive}
        />
      ))}
    </svg>
  );
}
