import { cn } from "@/lib/utils";

export function ProfileAvatar({
  className,
  name,
  url,
}: {
  className?: string;
  name: string;
  url: string | null;
}) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-control-hover font-semibold text-foreground",
        className,
      )}
    >
      {url ? (
        // Provider metadata can contain remote hosts that are not known at build time.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="" className="h-full w-full object-cover" src={url} />
      ) : (
        initial
      )}
    </span>
  );
}
