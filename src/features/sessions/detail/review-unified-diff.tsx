function patchLineKind(line: string) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "added";
  if (line.startsWith("-") && !line.startsWith("---")) return "removed";
  return "context";
}

export function ReviewUnifiedDiff({ patch, label }: { patch: string; label: string }) {
  return (
    <pre
      aria-label={label}
      className="mt-2 max-h-[28rem] overflow-auto rounded-[4px] border border-border bg-canvas p-3 text-xs leading-5"
      tabIndex={0}
    >
      <code>
        {patch.split("\n").map((line, index) => {
          const kind = patchLineKind(line);
          return (
            <span
              key={`${index}:${line.slice(0, 20)}`}
              className={
                kind === "added"
                  ? "block bg-success-soft text-success"
                  : kind === "removed"
                    ? "block bg-danger-soft text-danger"
                    : kind === "hunk"
                      ? "block text-accent"
                      : "block text-foreground"
              }
            >
              {line}
              {"\n"}
            </span>
          );
        })}
      </code>
    </pre>
  );
}
