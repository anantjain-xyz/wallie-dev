import { MetadataItem, MetadataList } from "@/components/ui/page-shell";

export function RunTechnicalDetails({
  entries,
}: {
  entries: [label: string, value: string | number | null | undefined][];
}) {
  const recorded = entries.filter(([, value]) => value != null);
  if (!recorded.length) return null;
  return (
    <details className="min-w-0 px-4 py-3 sm:px-5">
      <summary className="type-label cursor-pointer text-muted hover:text-foreground">
        Technical details
      </summary>
      <MetadataList className="mt-3">
        {recorded.map(([label, value]) => (
          <MetadataItem
            key={label}
            label={label}
            monospace
            value={
              <code className="select-text [overflow-wrap:anywhere]" translate="no">
                {value}
              </code>
            }
          />
        ))}
      </MetadataList>
    </details>
  );
}
