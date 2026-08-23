"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

function ProfileAvatarContent({ initial, url }: { initial: string; url: string | null }) {
  const [failed, setFailed] = useState(false);

  if (!url || failed) return initial;

  return (
    // Provider metadata can contain remote hosts that are not known at build time.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} src={url} />
  );
}

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
      <ProfileAvatarContent key={url ?? "initials"} initial={initial} url={url} />
    </span>
  );
}
