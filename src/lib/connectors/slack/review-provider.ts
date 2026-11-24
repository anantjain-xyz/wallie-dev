import "server-only";

import { z } from "zod/v4";

import { buildSlackClarificationModal } from "./interactions";

const openedView = z.object({
  ok: z.literal(true),
  view: z.object({ id: z.string().regex(/^V[A-Z0-9]{2,63}$/) }),
});

export async function openSlackClarificationModal(
  input: {
    botAccessToken: string;
    triggerId: string;
    targetId: string;
    signal?: AbortSignal;
  },
  fetcher: typeof fetch = fetch,
) {
  const deadline = AbortSignal.timeout(1_800);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const response = await fetcher("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.botAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      trigger_id: input.triggerId,
      view: buildSlackClarificationModal(input.targetId),
    }),
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error("Slack could not open the clarification form.");
  const opened = openedView.safeParse(await response.json().catch(() => null));
  if (!opened.success) throw new Error("Slack did not confirm the clarification form.");
  return opened.data.view.id;
}
