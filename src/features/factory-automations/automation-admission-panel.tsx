"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { automationAdmissionControlSchema } from "@/lib/factory-automations/admission-control-contracts";

const responseSchema = z.object({ control: automationAdmissionControlSchema });
type Control = z.infer<typeof automationAdmissionControlSchema>;

export function AutomationAdmissionPanel({
  initial,
  endpoint,
  activeRevision,
}: {
  initial: Control | null;
  endpoint: string;
  activeRevision: boolean;
}) {
  const router = useRouter();
  const [confirmed, setConfirmed] = useState<Control | null>(null);
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const control =
    confirmed && (!initial || confirmed.generation > initial.generation) ? confirmed : initial;

  async function update() {
    if (!control || !activeRevision || busy.current) return;
    busy.current = true;
    setPending(true);
    setFeedback("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedGeneration: control.generation,
          paused: !control.paused,
          maxConcurrentSessions: control.maxConcurrentSessions,
        }),
      });
      if (response.status === 409) {
        const latest = await fetch(endpoint, {
          cache: "no-store",
          signal: AbortSignal.timeout(8_000),
        });
        if (!latest.ok) throw new Error("Control unavailable");
        const parsed = responseSchema.parse(await latest.json()).control;
        if (parsed.automationId !== control.automationId) throw new Error("Unexpected automation");
        setConfirmed(parsed);
        setFeedback("The automation changed. Review its current status and try again.");
        router.refresh();
        return;
      }
      if (!response.ok) throw new Error("Control unavailable");
      const parsed = responseSchema.parse(await response.json()).control;
      if (parsed.automationId !== control.automationId) throw new Error("Unexpected automation");
      setConfirmed(parsed);
      router.refresh();
    } catch {
      setFeedback("Could not change automation status. Refresh this page and try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  if (!activeRevision) return null;
  if (!control)
    return (
      <p className="text-sm text-danger" role="alert">
        Could not load automation status. Refresh this page to try again.
      </p>
    );
  return (
    <div className="space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium" role="status">
          {control.paused ? "Paused" : "Enabled"}
        </span>
        <button
          type="button"
          className="ui-button"
          onClick={() => void update()}
          disabled={pending}
        >
          <ActionButtonLabel
            idle={control.paused ? "Resume automation" : "Pause automation"}
            pending={pending}
            pendingLabel={control.paused ? "Resuming…" : "Pausing…"}
          />
        </button>
      </div>
      {feedback ? (
        <p className="text-sm text-danger" role="alert">
          {feedback}
        </p>
      ) : null}
    </div>
  );
}
