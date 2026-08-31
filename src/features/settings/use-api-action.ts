"use client";

import { useCallback, useRef, useState } from "react";

import { idleActionFeedback, type ActionFeedback } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";

type ApiActionText<TResponse, TArgs extends unknown[]> =
  | string
  | null
  | ((payload: TResponse, args: TArgs) => string | null);

type ApiActionErrorText<TArgs extends unknown[]> =
  | string
  | ((error: unknown, args: TArgs) => string);

type ApiActionOptions<TResponse, TArgs extends unknown[], TResult> = {
  call: (...args: TArgs) => Promise<Response> | Response;
  errorText: ApiActionErrorText<TArgs>;
  onError?: (message: string, error: unknown, args: TArgs) => Promise<TResult> | TResult;
  onSuccess?: (payload: TResponse, args: TArgs) => Promise<TResult> | TResult;
  setFlashMessage: (message: FlashMessage) => void;
  successText?: ApiActionText<TResponse, TArgs>;
};

export async function readResponseJson<T>(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | (T & {
        code?: string;
        error?: string;
        missing?: string[];
      })
    | null;

  if (!response.ok) {
    const detail = payload?.missing?.length ? ` Missing: ${payload.missing.join(", ")}.` : "";

    throw new Error((payload?.error ?? "Request failed.") + detail);
  }

  if (!payload) {
    throw new Error("Request returned an empty response.");
  }

  return payload;
}

function resolveSuccessText<TResponse, TArgs extends unknown[]>(
  successText: ApiActionText<TResponse, TArgs> | undefined,
  payload: TResponse,
  args: TArgs,
) {
  if (typeof successText === "function") {
    return successText(payload, args);
  }

  return successText ?? null;
}

function resolveErrorText<TArgs extends unknown[]>(
  errorText: ApiActionErrorText<TArgs>,
  error: unknown,
  args: TArgs,
) {
  const fallback = typeof errorText === "function" ? errorText(error, args) : errorText;

  return error instanceof Error && error.message ? error.message : fallback;
}

export function useApiAction<TResponse, TArgs extends unknown[] = [], TResult = void>({
  call,
  errorText,
  onError,
  onSuccess,
  setFlashMessage,
  successText,
}: ApiActionOptions<TResponse, TArgs, TResult>) {
  const [isBusy, setIsBusy] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback>(idleActionFeedback);
  const inFlightRef = useRef(false);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | undefined> => {
      // React state does not update until the next render. The ref closes the
      // same-frame gap so rapid clicks can never start duplicate requests.
      if (inFlightRef.current) return undefined;
      inFlightRef.current = true;
      setIsBusy(true);
      setFeedback({ message: null, status: "pending" });

      try {
        const response = await call(...args);
        const payload = await readResponseJson<TResponse>(response);
        const result = await onSuccess?.(payload, args);
        const message = resolveSuccessText(successText, payload, args);

        if (message) {
          setFlashMessage({ kind: "success", text: message });
        }

        setFeedback({ message, status: "success" });

        return result;
      } catch (error) {
        const message = resolveErrorText(errorText, error, args);

        setFlashMessage({ kind: "error", text: message });
        setFeedback({ message, status: "error" });
        return onError?.(message, error, args);
      } finally {
        inFlightRef.current = false;
        setIsBusy(false);
      }
    },
    [call, errorText, onError, onSuccess, setFlashMessage, successText],
  );

  return { feedback, isBusy, run };
}
