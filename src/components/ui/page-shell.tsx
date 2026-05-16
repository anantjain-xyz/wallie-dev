import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type PageContainerProps = {
  children: ReactNode;
  className?: string;
};

export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className={cn("mx-auto max-w-[1080px] px-6 pb-24 pt-10 sm:px-8", className)}>
      {children}
    </div>
  );
}

type PageHeaderProps = {
  actions?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  /**
   * When true, eyebrow renders without uppercase/tracking treatment. Useful when
   * the eyebrow is a "← Back" link that should read naturally.
   */
  eyebrowAsPlain?: boolean;
  title: ReactNode;
};

export function PageHeader({
  actions,
  description,
  eyebrow,
  eyebrowAsPlain = false,
  title,
}: PageHeaderProps) {
  return (
    <header className="mb-10 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 space-y-2">
        {eyebrow ? (
          <div
            className={
              eyebrowAsPlain
                ? "text-[12px] font-medium text-muted"
                : "text-[12px] font-medium uppercase tracking-[0.08em] text-muted"
            }
          >
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-[28px] font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-[14px] leading-6 text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

type PageSectionProps = {
  actions?: ReactNode;
  anchorId?: string;
  children: ReactNode;
  className?: string;
  statusBadge?: ReactNode;
  tagline?: ReactNode;
  title: string;
};

export function PageSection({
  actions,
  anchorId,
  children,
  className,
  statusBadge,
  tagline,
  title,
}: PageSectionProps) {
  return (
    <section id={anchorId} className={cn("scroll-mt-8", className)}>
      <header className="settings-section-header mb-6">
        <div className="min-w-0 space-y-1">
          <h2 className="text-[18px] font-semibold tracking-tight text-foreground">{title}</h2>
          {tagline ? <p className="text-[13px] leading-5 text-muted">{tagline}</p> : null}
        </div>
        {statusBadge || actions ? (
          <div className="flex shrink-0 items-center gap-2">
            {statusBadge}
            {actions}
          </div>
        ) : null}
      </header>
      <div>{children}</div>
    </section>
  );
}
