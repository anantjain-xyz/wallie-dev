// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import {
  SessionsLedgerVisibilityProvider,
  useSessionsLedgerVisibility,
} from "@/features/sessions/list/sessions-ledger-visibility";

function Harness({
  onReady,
}: {
  onReady: (api: { hideSession: (id: string) => void; hiddenCount: number }) => void;
}) {
  const visibility = useSessionsLedgerVisibility();
  useEffect(() => {
    if (!visibility) return;
    onReady({
      hideSession: visibility.hideSession,
      hiddenCount: visibility.hiddenCount,
    });
  }, [onReady, visibility]);
  return <div data-testid="children">rows</div>;
}

function renderProvider(sessionIds: readonly string[], child: ReactNode) {
  return (
    <SessionsLedgerVisibilityProvider
      emptyFallback={<div data-testid="empty">empty</div>}
      sessionIds={sessionIds}
    >
      {child}
    </SessionsLedgerVisibilityProvider>
  );
}

describe("SessionsLedgerVisibilityProvider", () => {
  it("ignores stale hidden ids from a prior result set", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    const latest = {
      current: null as {
        hideSession: (id: string) => void;
        hiddenCount: number;
      } | null,
    };

    await act(async () => {
      root.render(
        renderProvider(
          ["a", "b"],
          <Harness
            onReady={(api) => {
              latest.current = api;
            }}
          />,
        ),
      );
    });

    expect(latest.current).not.toBeNull();
    await act(async () => {
      latest.current!.hideSession("a");
    });

    await act(async () => {
      root.render(
        renderProvider(
          ["c"],
          <Harness
            onReady={(api) => {
              latest.current = api;
            }}
          />,
        ),
      );
    });

    expect(container.querySelector('[data-testid="empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="children"]')).not.toBeNull();
    expect(latest.current?.hiddenCount).toBe(0);

    root.unmount();
    container.remove();
  });
});
