import { PageSection } from "@/components/ui/page-shell";
import { previewFactoryAutomationSchedule } from "@/lib/factory-automations/schedule-service";

type Preview = typeof previewFactoryAutomationSchedule;

export async function AutomationSchedulePreview({
  client,
  input,
}: {
  client: Parameters<Preview>[0];
  input: Parameters<Preview>[1];
}) {
  const preview = await previewFactoryAutomationSchedule(client, input);
  if (!preview) return null;

  const formatter = preview.available
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: input.timeZone,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : null;

  function time(value: string) {
    return <time dateTime={value}>{formatter?.format(new Date(value)) ?? value}</time>;
  }

  return (
    <PageSection title="Schedule" tagline={input.timeZone}>
      <div className="ui-sheet min-w-0 space-y-4 p-4 text-sm sm:p-6">
        {!preview.available ? (
          <p className="text-danger">The schedule or timezone is unavailable.</p>
        ) : (
          <>
            <div className="space-y-1.5">
              <h3 className="type-label">
                {preview.current && !preview.archived && !preview.paused
                  ? "Next scheduled times"
                  : "Upcoming calendar matches"}
              </h3>
              {preview.next.length ? (
                <ul className="space-y-1 text-muted">
                  {preview.next.map((instant) => (
                    <li key={instant}>{time(instant)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">No matches in the next eight years.</p>
              )}
            </div>
            {preview.catchUp ? (
              <div className="space-y-1.5 border-t border-border pt-4">
                <h3 className="type-label">
                  {preview.paused ? "Paused · Catch-up preview" : "Resume pending"}
                </h3>
                {preview.catchUp.occurrenceAt ? (
                  <p className="text-muted">
                    One missed occurrence will be queued for {time(preview.catchUp.occurrenceAt)}.
                  </p>
                ) : (
                  <p className="text-muted">No missed occurrence will be queued.</p>
                )}
                <p className="type-secondary text-muted">
                  Calculated through {time(preview.catchUp.through)}.
                </p>
              </div>
            ) : null}
            {preview.lastResume ? (
              <div className="space-y-1.5 border-t border-border pt-4">
                <h3 className="type-label">Last resume at {time(preview.lastResume.through)}</h3>
                {preview.lastResume.occurrenceAt ? (
                  <p className="text-muted">
                    Queued missed occurrence for {time(preview.lastResume.occurrenceAt)}.
                  </p>
                ) : (
                  <p className="text-muted">No missed occurrence was queued.</p>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </PageSection>
  );
}
