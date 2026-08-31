"use client";

import { useState } from "react";

import type { FlashMessage } from "@/features/settings/settings-types";
import { toneClass } from "@/features/settings/settings-ui";

export function useIslandFeedback(initialMessage: FlashMessage | null = null) {
  const [message, setMessage] = useState<FlashMessage | null>(initialMessage);
  const feedback = message ? (
    <div
      aria-live="polite"
      className={`mb-4 rounded-[6px] border px-4 py-3 text-sm ${toneClass(message.kind)}`}
      role={message.kind === "error" ? "alert" : "status"}
    >
      {message.text}
    </div>
  ) : null;

  return { feedback, setMessage };
}
