"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { z } from "zod";

import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";

export function useGovernanceAction<
  Command extends { action: string },
  Result extends { action: string },
>({
  endpoint,
  response,
  successText,
}: {
  endpoint: string;
  response: z.ZodType<Result>;
  successText: string;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [conflict, setConflict] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const action = useApiAction<unknown, [Command], Result>({
    async call(command) {
      const result = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (result.status === 409) setConflict(true);
      return result;
    },
    onSuccess(payload, [command]) {
      const result = response.safeParse(payload);
      if (!result.success || result.data.action !== command.action)
        throw new Error("Could not read the saved scorer action.");
      startRefresh(() => router.refresh());
      return result.data;
    },
    errorText: "Could not apply the scorer action.",
    setFlashMessage: setMessage,
    successText,
  });
  return {
    ...action,
    message,
    setMessage,
    conflict,
    busy: action.isBusy || refreshing,
    reload() {
      setConflict(false);
      startRefresh(() => router.refresh());
    },
  };
}
