import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Precision Console layout vocabulary. Canvas comes from the page, Sheet is
 * the sole routine content surface, and floating overlay primitives live in
 * their dedicated modules. Rules and spacing subdivide a Sheet; never nest it.
 */

type PageContainerProps = {
  children: ReactNode;
  className?: string;
};

export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div className={cn("mx-auto max-w-[1080px] px-4 pb-24 pt-8 sm:px-8 sm:pt-10", className)}>
      {children}
    </div>
  );
}

export const PAGE_HEADER_TITLE_CLASS = "type-page-title break-words";

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
  /**
   * When true, render `title` as-is instead of wrapping it in the default `<h1>`.
   * Use when the title needs adjacent controls (e.g. inline editing) that must
   * stay outside the heading so the heading's accessible name is only its text.
   * The caller is responsible for rendering its own heading.
   */
  titleAsChild?: boolean;
};

export function PageHeader({
  actions,
  description,
  eyebrow,
  eyebrowAsPlain = false,
  title,
  titleAsChild = false,
}: PageHeaderProps) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 sm:mb-10">
      <div className="min-w-0 space-y-2">
        {eyebrow ? (
          <div
            className={
              eyebrowAsPlain
                ? "type-label text-muted"
                : "type-label uppercase tracking-[0.08em] text-muted"
            }
          >
            {eyebrow}
          </div>
        ) : null}
        {titleAsChild ? title : <h1 className={PAGE_HEADER_TITLE_CLASS}>{title}</h1>}
        {description ? <p className="type-body max-w-2xl text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

type CommandBarProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
};

export function CommandBar({ children, className, ...props }: CommandBarProps) {
  return (
    <div className={cn("ui-command-bar", className)} {...props}>
      {children}
    </div>
  );
}

type SheetProps = HTMLAttributes<HTMLElement> & {
  children: ReactNode;
};

/** Primary content surface. Do not nest Sheet inside Sheet. */
export function Sheet({ children, className, ...props }: SheetProps) {
  return (
    <section className={cn("ui-sheet", className)} {...props}>
      {children}
    </section>
  );
}

type MetadataListProps = HTMLAttributes<HTMLDListElement> & {
  children: ReactNode;
};

export function MetadataList({ children, className, ...props }: MetadataListProps) {
  return (
    <dl className={cn("ui-metadata-list", className)} {...props}>
      {children}
    </dl>
  );
}

type MetadataItemProps = HTMLAttributes<HTMLDivElement> & {
  label: ReactNode;
  monospace?: boolean;
  value: ReactNode;
};

export function MetadataItem({
  className,
  label,
  monospace = false,
  value,
  ...props
}: MetadataItemProps) {
  return (
    <div className={cn("ui-metadata-item", className)} {...props}>
      <dt className="ui-metadata-term">{label}</dt>
      <dd className={cn("ui-metadata-value", monospace && "font-mono")}>{value}</dd>
    </div>
  );
}

export type StatusTone = "accent" | "danger" | "neutral" | "success" | "warning";

type StatusProps = HTMLAttributes<HTMLSpanElement> & {
  children: ReactNode;
  tone?: StatusTone;
  withDot?: boolean;
};

export function Status({
  children,
  className,
  tone = "neutral",
  withDot = true,
  ...props
}: StatusProps) {
  return (
    <span className={cn("ui-status", `ui-status-${tone}`, className)} {...props}>
      {withDot ? <span aria-hidden="true" className="ui-status-dot" /> : null}
      {children}
    </span>
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
          <h2 className="type-section-title">{title}</h2>
          {tagline ? <p className="type-secondary text-muted">{tagline}</p> : null}
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
