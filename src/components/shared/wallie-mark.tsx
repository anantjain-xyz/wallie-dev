import { cn } from "@/lib/utils";

type WallieMarkProps = {
  className?: string;
};

export function WallieMark({ className }: WallieMarkProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-11 w-11 items-center justify-center rounded-2xl border border-foreground/10 bg-[linear-gradient(135deg,rgba(184,79,47,0.95),rgba(244,182,113,0.9))] text-lg font-black text-white shadow-[0_14px_40px_rgba(184,79,47,0.25)]",
        className,
      )}
    >
      W
    </div>
  );
}
